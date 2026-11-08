import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { getProfileAnalytics } from "@/features/analytics/service";
import * as svc from "@/features/profiles/service";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { signUp } from "../support/auth-http";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

/**
 * Analytics performance budget: the 90-day dashboard aggregate for a profile
 * with at least 100,000 events in the window, under one second on the test
 * PostgreSQL, using the intended indexes. The table also holds the profile's
 * own older events and 1,000,000 events of 20 other profiles (a multi-tenant
 * installation), so the queries must select. When one profile is most of the
 * table, PostgreSQL rightly prefers a sequential scan; that case is measured
 * first, against the same budget.
 */

const TARGET_IN_WINDOW = 100_000;
const TARGET_OLDER = 20_000;
const OTHER_PROFILES = 20;
const PER_OTHER_PROFILE = 50_000;
const BUDGET_MS = 1000;

let ownerId = "";
let profileId = "";

beforeAll(async () => {
  await resetDatabase();
  await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" });
  for (const email of ["perf@example.com", "other@example.com"]) expect((await signUp(email)).status).toBe(200);
  [{ id: ownerId }] = (await testSql()`select id from users where email = 'perf@example.com'`) as unknown as { id: string }[];
  const [{ id: otherId }] = (await testSql()`select id from users where email = 'other@example.com'`) as unknown as { id: string }[];
  ({ id: profileId } = await svc.createProfile(ownerId, { handle: "perf", label: "Perf", displayName: "Perf" }));
  // Other profiles are inserted directly (beyond the per-user profile limit; only the rows matter here).
  const others = (await testSql()`
    insert into profiles (owner_id, handle, label, draft)
    select ${otherId}, 'other-' || g, 'Other ' || g, '{}'::jsonb from generate_series(1, ${OTHER_PROFILES}::int) g
    returning id`) as unknown as { id: string }[];

  // Views with hashes (about 1 in 3 repeating), clicks on 12 links, mixed devices, referrers and sources.
  const seed = (pid: string, n: number, fromDays: number, spanDays: number) => testSql()`
    insert into analytics_events (profile_id, type, block_id, visitor_hash, referrer_host, device, source, occurred_at)
    select ${pid}::uuid,
           case when i % 4 = 0 then 'click' else 'view' end,
           case when i % 4 = 0 then ('00000000-0000-4000-8000-' || lpad((i % 12)::text, 12, '0'))::uuid end,
           case when i % 5 = 0 then null else encode(sha256(convert_to((i % (${n}::int / 3))::text, 'UTF8')), 'hex') end,
           case when i % 4 = 0 then null when i % 7 = 0 then 'news.example.org' when i % 11 = 0 then 'social.example.net' end,
           (array['mobile','desktop','tablet','unknown'])[1 + i % 4],
           case when i % 4 <> 0 and i % 13 = 0 then 'qr' end,
           now() - make_interval(days => ${fromDays}::int) - (random() * ${spanDays}::int * interval '1 day')
    from generate_series(1, ${n}::int) i`;
  await seed(profileId, TARGET_IN_WINDOW, 0, 89);
  await seed(profileId, TARGET_OLDER, 95, 200);
  await testSql()`analyze analytics_events`;
  // Single-tenant shape first: this profile is the whole table.
  await getProfileAnalytics(ownerId, profileId, { range: "90" }); // warm-up
  const t1 = performance.now();
  await getProfileAnalytics(ownerId, profileId, { range: "90" });
  singleTenantMs = performance.now() - t1;
  for (const other of others) await seed(other.id, PER_OTHER_PROFILE, 0, 300);
  await testSql()`analyze analytics_events`;
}, 600_000);

let singleTenantMs = 0;

describe("90-day aggregate with 100,000+ events", () => {
  it(`completes within ${BUDGET_MS} ms and uses the profile/time indexes`, async () => {
    expect(singleTenantMs).toBeLessThan(BUDGET_MS);
    const [{ n }] = await testSql()`select count(*)::int as n from analytics_events where profile_id = ${profileId} and occurred_at >= now() - interval '90 days'`;
    expect(n).toBeGreaterThanOrEqual(TARGET_IN_WINDOW);

    await getProfileAnalytics(ownerId, profileId, { range: "90" }); // warm-up (plan and buffer cache)
    const timings: number[] = [];
    let result;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      result = await getProfileAnalytics(ownerId, profileId, { range: "90" });
      timings.push(performance.now() - t0);
    }
    timings.sort((a, b) => a - b);
    const median = timings[2];
    const worst = timings[4];
    expect(result!.totals.views + result!.totals.clicks).toBeGreaterThanOrEqual(TARGET_IN_WINDOW);

    const start = result!.range.start.toISOString();
    const end = result!.range.end.toISOString();
    const plan = async (query: string) => {
      const [row] = await testSql().unsafe(`explain (analyze, buffers, format json) ${query}`, [profileId, start, end]);
      const json = JSON.stringify(row["QUERY PLAN"]);
      return { indexes: [...new Set([...json.matchAll(/"Index Name":"([^"]+)"/g)].map((m) => m[1]))], ms: row["QUERY PLAN"][0]["Execution Time"] as number };
    };
    const scope = "profile_id = $1 and occurred_at >= $2::timestamptz and occurred_at < $3::timestamptz";
    const daily = await plan(`select to_char((occurred_at at time zone 'utc')::date, 'YYYY-MM-DD') as day,
      count(*) filter (where type = 'view')::int, count(*) filter (where type = 'click')::int,
      count(distinct visitor_hash) filter (where type = 'view')::int, count(*) filter (where type = 'view' and visitor_hash is null)::int
      from analytics_events where ${scope} group by 1`);
    const links = await plan(`select block_id, count(*)::int as clicks from analytics_events where ${scope} and type = 'click' group by block_id order by clicks desc, block_id limit 10`);
    const refs = await plan(`select referrer_host as key, count(*)::int as views from analytics_events where ${scope} and type = 'view' group by 1 order by views desc, key nulls last limit 10`);

    const report =
      `[perf] events: profile in window ${n}, profile older ${TARGET_OLDER}, ${OTHER_PROFILES} other profiles × ${PER_OTHER_PROFILE}; ` +
      `getProfileAnalytics(90 days) median ${median.toFixed(0)} ms, worst ${worst.toFixed(0)} ms of 5; ` +
      `daily ${daily.ms.toFixed(0)} ms via [${daily.indexes}], top links ${links.ms.toFixed(0)} ms via [${links.indexes}], referrers ${refs.ms.toFixed(0)} ms via [${refs.indexes}]; ` +
      `single tenant warm ${singleTenantMs.toFixed(0)} ms`;
    console.log(report);
    // Vitest hides console output of passing tests; ANALYTICS_PERF_REPORT=<file> keeps the measurement.
    if (process.env.ANALYTICS_PERF_REPORT) appendFileSync(process.env.ANALYTICS_PERF_REPORT, `${new Date().toISOString()} ${report}\n`);
    expect(worst).toBeLessThan(BUDGET_MS);
    expect(daily.indexes.some((i) => i.startsWith("analytics_events_profile_"))).toBe(true);
    expect(links.indexes).toContain("analytics_events_profile_type_time_idx");
    expect(refs.indexes.some((i) => i.startsWith("analytics_events_profile_"))).toBe(true);
  }, 120_000);
});
