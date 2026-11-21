import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Counts an attempt against `key` in the `rate_limits` table Better Auth
 * already keeps (its own keys are `<ip>|<path>`; ours start with
 * `covalink:`). One atomic upsert: the count restarts when the previous
 * attempt is older than the window. Returns true while the attempt is within
 * `max`. Used where Better Auth's HTTP rate limiter doesn't apply because
 * COVALink calls `auth.api.*` from a Server Action.
 *
 * By default every attempt, refused ones included, restarts the window, which
 * keeps a guesser locked out while they keep trying. With `refusedExtend:
 * false` a refused attempt leaves the window alone, so a limit shared by many
 * people (Subscribe's per-profile and installation-wide limits) can't be held
 * shut by a trickle of attempts.
 */
export async function consumeAttempt(
  key: string,
  windowSeconds: number,
  max: number,
  { refusedExtend = true }: { refusedExtend?: boolean } = {},
): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const refused = refusedExtend ? sql`false` : sql`rate_limits.last_request >= ${cutoff} and rate_limits.count >= ${max}`;
  const rows = await db.execute<{ count: number }>(sql`
    insert into rate_limits (id, key, count, last_request)
    values (${crypto.randomUUID()}, ${`covalink:${key}`}, 1, ${now})
    on conflict (key) do update set
      count = case when rate_limits.last_request < ${cutoff} then 1 else rate_limits.count + 1 end,
      last_request = case when ${refused} then rate_limits.last_request else ${now} end
    returning count`);
  return Number(rows[0]?.count) <= max;
}

/** Attempts counted against `key` in the current window, without counting one or creating a row. */
export async function attemptsUsed(key: string, windowSeconds: number): Promise<number> {
  const cutoff = Date.now() - windowSeconds * 1000;
  const rows = await db.execute<{ count: number }>(sql`
    select count from rate_limits where key = ${`covalink:${key}`} and last_request >= ${cutoff}`);
  return Number(rows[0]?.count ?? 0);
}

/** Deletes this module's rows under `prefix` whose window has passed. */
export async function purgeAttempts(prefix: string, windowSeconds: number): Promise<void> {
  const cutoff = Date.now() - windowSeconds * 1000;
  await db.execute(sql`delete from rate_limits where key like ${`covalink:${prefix}%`} and last_request < ${cutoff}`);
}
