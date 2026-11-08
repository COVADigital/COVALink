import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  cacheTag: vi.fn(),
  cacheLife: vi.fn(),
}));

import { listAuditEntries } from "@/features/admin/audit";
import { listUsers } from "@/features/admin/users";
import { bootstrapSuperAdmin } from "@/features/setup/service";
import { resetDatabase, testSql } from "../support/db";
import { TEST_SETUP_TOKEN } from "../support/test-env";

/**
 * Administration performance budget: a user page with 10,000 users and an audit
 * page with 100,000 entries under 500 ms, including searches and filters,
 * with the plans recorded. PERF_REPORT=<file> keeps the measurements (Vitest
 * hides console output of passing tests).
 */

const USERS = 10_000;
const AUDIT = 100_000;
const BUDGET_MS = 500;
let superId = "";

async function time(fn: () => Promise<unknown>): Promise<number> {
  await fn(); // warm-up
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    await fn();
    runs.push(performance.now() - t0);
  }
  return Math.max(...runs);
}

beforeAll(async () => {
  await resetDatabase();
  ({ userId: superId } = await bootstrapSuperAdmin({ token: TEST_SETUP_TOKEN, name: "Owner", email: "owner@example.com", password: "correct-horse-battery" }));
  // 10,000 accounts over a year, 10% disabled, 2% admins, creation times often equal (per minute).
  await testSql()`
    insert into users (id, name, email, role, banned, created_at)
    select 'perf-' || lpad(g::text, 5, '0'), 'Member ' || g, 'member' || g || '@example.com',
           case when g % 50 = 0 then 'admin' else 'user' end, g % 10 = 0,
           now() - make_interval(mins => (g / 3)::int)
    from generate_series(1, ${USERS}::int) g`;
  // One profile per three accounts (for the profile-count subquery).
  await testSql()`
    insert into profiles (owner_id, handle, label, draft)
    select 'perf-' || lpad(g::text, 5, '0'), 'perf-' || g, 'P' || g, '{}'::jsonb from generate_series(1, ${USERS}::int, 3) g`;
  // 100,000 audit entries over 400 days, mixed actions and actors; many share a timestamp.
  await testSql()`
    insert into audit_logs (actor_id, action, target_type, target_id, metadata, created_at)
    select case when g % 7 = 0 then ${superId} else 'perf-' || lpad(((g % 200) * 50 + 50)::text, 5, '0') end,
           (array['user.ban','user.unban','user.role_change','settings.update'])[1 + g % 4],
           case when g % 4 = 3 then 'setting' else 'user' end,
           case when g % 4 = 3 then 'site.name' else 'perf-' || lpad((1 + g % ${USERS}::int)::text, 5, '0') end,
           case when g % 4 = 2 then '{"from":"user","to":"admin"}'::jsonb end,
           now() - make_interval(secs => (g / 4) * 345)
    from generate_series(1, ${AUDIT}::int) g`;
  await testSql()`analyze users`;
  await testSql()`analyze profiles`;
  await testSql()`analyze audit_logs`;
}, 600_000);

describe("admin pages at scale", () => {
  it(`user and audit pages stay under ${BUDGET_MS} ms with searches and filters, and the plans are recorded`, async () => {
    const u = {
      first: await time(() => listUsers(superId, {})),
      last: await time(() => listUsers(superId, { page: Math.ceil((USERS + 1) / 25) })),
      search: await time(() => listUsers(superId, { q: "member77" })),
      searchEmail: await time(() => listUsers(superId, { q: "@EXAMPLE.COM", page: 200 })),
      filtered: await time(() => listUsers(superId, { role: "admin", status: "disabled" })),
    };
    // A deep audit page: follow 20 cursors first.
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) cursor = (await listAuditEntries(superId, cursor ? { cursor } : {})).nextCursor ?? undefined;
    const deepCursor = cursor!;
    const a = {
      first: await time(() => listAuditEntries(superId, {})),
      deep: await time(() => listAuditEntries(superId, { cursor: deepCursor })),
      action: await time(() => listAuditEntries(superId, { action: "user.role_change" })),
      actor: await time(() => listAuditEntries(superId, { actor: superId })),
      target: await time(() => listAuditEntries(superId, { target: "perf-04242" })),
      range: await time(() => listAuditEntries(superId, { from: "2026-01-01", to: "2026-03-31", action: "user.unban" })),
    };
    const plan = async (query: string, params: unknown[] = []) => {
      const [row] = await testSql().unsafe(`explain (analyze, format json) ${query}`, params as never[]);
      const json = JSON.stringify(row["QUERY PLAN"]);
      const nodes = [...new Set([...json.matchAll(/"Node Type":"([^"]+)"/g)].map((m) => m[1]))];
      const indexes = [...new Set([...json.matchAll(/"Index Name":"([^"]+)"/g)].map((m) => m[1]))];
      return `${(row["QUERY PLAN"][0]["Execution Time"] as number).toFixed(1)} ms [${indexes.join(",") || "no index"}; ${nodes.join(",")}]`;
    };
    const plans = {
      userSearch: await plan(
        `select id from users where (name ilike $1 escape '\\' or email ilike $1 escape '\\') order by created_at desc, id desc limit 25`,
        ["%member77%"],
      ),
      userCount: await plan(`select count(*) from users where (name ilike $1 escape '\\' or email ilike $1 escape '\\')`, ["%member77%"]),
      auditFirst: await plan(`select id from audit_logs order by created_at desc, id desc limit 51`),
      auditTarget: await plan(`select id from audit_logs where target_id = $1 order by created_at desc, id desc limit 51`, ["perf-04242"]),
      auditActor: await plan(`select id from audit_logs where actor_id = $1 order by created_at desc, id desc limit 51`, [superId]),
    };
    const fmt = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(0)} ms`).join(", ");
    const report = `[admin-perf] ${USERS} users, ${AUDIT} audit entries; worst of 3 after warm-up: users {${fmt(u)}}; audit {${fmt(a)}}; plans ${JSON.stringify(plans)}`;
    console.log(report);
    if (process.env.PERF_REPORT) appendFileSync(process.env.PERF_REPORT, `${new Date().toISOString()} ${report}\n`);
    for (const [name, ms] of Object.entries({ ...u, ...Object.fromEntries(Object.entries(a).map(([k, v]) => [`audit.${k}`, v])) })) {
      expect(ms, name).toBeLessThan(BUDGET_MS);
    }
  }, 300_000);
});
