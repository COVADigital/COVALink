import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { readDocument } from "@/features/profiles/document";
import { getSetting } from "@/features/settings/service";
import { AppError } from "@/lib/errors";
import { DEVICES, type Device } from "./classify";
import { fillDaily, totals, type DailyRow, type Totals } from "./metrics";
import { rangeDays, resolveRange, type AnalyticsRange, type RangeInput } from "./range";

/**
 * Owner-only analytics reads. The ownership check is part of this
 * service, not the page: the profile row is selected by id **and** owner, and
 * every aggregate query is scoped to that profile id, so another user's id,
 * a guessed id or a tampered active-profile cookie yields NOT_FOUND and no
 * numbers. Queries cover the half-open UTC interval [range.start, range.end).
 * Referrers, devices and sources describe views; top links describe clicks.
 */

export const TOP_LIMIT = 10;

export interface LinkStat {
  blockId: string;
  /**
   * The link's title in the current published snapshot ("Social links" for a
   * social block, "Image: {alt}" or "Image" for an image); null when the
   * block no longer exists.
   */
  title: string | null;
  hidden: boolean;
  clicks: number;
}

export interface BreakdownRow<K extends string | null = string | null> {
  key: K;
  views: number;
}

export interface ProfileAnalytics {
  profile: { id: string; handle: string; label: string; isPublished: boolean };
  range: AnalyticsRange;
  rangeError: string | null;
  retentionDays: number;
  totals: Totals;
  daily: DailyRow[];
  topLinks: LinkStat[];
  referrers: BreakdownRow[];
  devices: BreakdownRow<Device>[];
  sources: BreakdownRow[];
}

export async function getProfileAnalytics(
  ownerId: string,
  profileId: string,
  input: RangeInput = {},
  now: Date = new Date(),
): Promise<ProfileAnalytics> {
  if (typeof ownerId !== "string" || !ownerId || !z.uuid().safeParse(profileId).success) {
    throw new AppError("Profile not found", "NOT_FOUND");
  }
  const [profile] = await db
    .select({
      id: profiles.id,
      handle: profiles.handle,
      label: profiles.label,
      isPublished: profiles.isPublished,
      published: profiles.published,
    })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), eq(profiles.ownerId, ownerId)))
    .limit(1);
  if (!profile) throw new AppError("Profile not found", "NOT_FOUND");

  const retentionDays = await getSetting("analytics.retentionDays");
  const resolved = resolveRange(input, { now, retentionDays });
  const { range } = resolved;
  const scope = sql`profile_id = ${profile.id} and occurred_at >= ${range.start.toISOString()}::timestamptz and occurred_at < ${range.end.toISOString()}::timestamptz`;

  const [dailyRows, linkRows, referrerRows, deviceRows, sourceRows] = await Promise.all([
    db.execute<{ day: string; views: number; clicks: number; visitors: number; unhashed: number }>(sql`
      select to_char((occurred_at at time zone 'utc')::date, 'YYYY-MM-DD') as day,
             count(*) filter (where type = 'view')::int as views,
             count(*) filter (where type = 'click')::int as clicks,
             count(distinct visitor_hash) filter (where type = 'view')::int as visitors,
             count(*) filter (where type = 'view' and visitor_hash is null)::int as unhashed
      from analytics_events where ${scope}
      group by 1`),
    db.execute<{ block_id: string; clicks: number }>(sql`
      select block_id, count(*)::int as clicks from analytics_events
      where ${scope} and type = 'click'
      group by block_id order by clicks desc, block_id limit ${TOP_LIMIT}`),
    breakdown("referrer_host", scope),
    breakdown("device", scope),
    breakdown("source", scope),
  ]);

  const daily = fillDaily(
    rangeDays(range),
    dailyRows.map((r) => ({ day: r.day, views: r.views, clicks: r.clicks, visitors: r.visitors, viewsWithoutHash: r.unhashed })),
  );
  const blocks = profile.published ? readDocument(profile.published, profile.label).doc.blocks : [];
  const topLinks = linkRows.map((r): LinkStat => {
    const block = blocks.find((b) => b.id === r.block_id);
    // Social clicks are aggregated per block, so the block is the row.
    const title =
      block?.type === "link"
        ? block.config.title
        : block?.type === "social"
          ? "Social links"
          : block?.type === "image"
            ? block.config.alt
              ? `Image: ${block.config.alt}`
              : "Image"
            : null;
    return { blockId: r.block_id, title, hidden: Boolean(block && !block.visible), clicks: r.clicks };
  });
  const deviceCounts = new Map<string | null, number>(deviceRows.map((r) => [r.key, r.views]));

  return {
    profile: { id: profile.id, handle: profile.handle, label: profile.label, isPublished: profile.isPublished },
    range,
    rangeError: resolved.ok ? null : resolved.error,
    retentionDays,
    totals: totals(daily),
    daily,
    topLinks,
    referrers: referrerRows,
    devices: DEVICES.map((key) => ({ key, views: deviceCounts.get(key) ?? 0 })).filter((r) => r.views > 0),
    sources: sourceRows,
  };
}

async function breakdown(column: "referrer_host" | "device" | "source", scope: ReturnType<typeof sql>): Promise<BreakdownRow[]> {
  const col = sql.identifier(column);
  const rows = await db.execute<{ key: string | null; views: number }>(sql`
    select ${col} as key, count(*)::int as views from analytics_events
    where ${scope} and type = 'view'
    group by 1 order by views desc, key nulls last limit ${TOP_LIMIT}`);
  return rows.map((r) => ({ key: r.key, views: r.views }));
}
