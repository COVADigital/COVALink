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
 */
export async function consumeAttempt(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const now = Date.now();
  const cutoff = now - windowSeconds * 1000;
  const rows = await db.execute<{ count: number }>(sql`
    insert into rate_limits (id, key, count, last_request)
    values (${crypto.randomUUID()}, ${`covalink:${key}`}, 1, ${now})
    on conflict (key) do update set
      count = case when rate_limits.last_request < ${cutoff} then 1 else rate_limits.count + 1 end,
      last_request = ${now}
    returning count`);
  return Number(rows[0]?.count) <= max;
}
