import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { analyticsEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { trustedClientAddress } from "@/lib/security/client-address";
import { deviceCategory, isBot, isPrefetch, referrerHost, userAgentClass, type Source } from "./classify";
import { isOwnerRequest } from "./owner";
import { currentSalt } from "./salts";
import { visitorHash } from "./visitor";

/**
 * Analytics ingestion: one function for views and clicks.
 * Filters run cheapest first: prefetch and bot (headers only), then the
 * owner check (only when a session cookie is present). An accepted event is
 * written in a transaction holding a per-profile advisory lock, so repeat
 * suppression and the per-visitor and per-profile limits can't be raced by
 * parallel requests. Rejected events aren't stored, so the limits bound
 * writes. Any failure discards the event (fail closed) and is logged with an
 * error code only: no headers, addresses, user agents, referrers, salts or
 * hashes.
 */

export type EventOutcome = "recorded" | "prefetch" | "bot" | "owner" | "repeat" | "rate_limited" | "error";

/** Accepted events per rolling minute. */
export const INGEST_LIMITS = { perVisitor: 20, perProfile: 300, global: 3000 } as const;
export const REPEAT_VIEW_MINUTES = 30;

/** Advisory-lock class for per-profile ingestion locks (two-key form; the migrator uses a one-key lock). */
const PROFILE_LOCK_CLASS = 727_002;

export interface EventInput {
  type: "view" | "click";
  profileId: string;
  ownerId: string;
  /** Click events only. */
  blockId?: string;
  headers: Headers;
  /** View events only: an allowlisted source and the browser-reported referrer URL. */
  source?: Source | null;
  referrer?: string | null;
}

export interface IngestOptions {
  trustProxy?: boolean;
  limits?: { perVisitor: number; perProfile: number; global: number };
}

export async function recordEvent(input: EventInput, options: IngestOptions = {}): Promise<EventOutcome> {
  const { headers } = input;
  if (isPrefetch(headers)) return "prefetch";
  const userAgent = headers.get("user-agent");
  if (isBot(userAgent)) return "bot";
  const e = env();
  const limits = options.limits ?? INGEST_LIMITS;
  try {
    if (await isOwnerRequest(headers, input.ownerId, e.BETTER_AUTH_SECRET)) return "owner";
    const address = trustedClientAddress(headers, options.trustProxy ?? e.TRUST_PROXY);
    const hash = address
      ? visitorHash({ salt: await currentSalt(), address, uaClass: userAgentClass(userAgent), profileId: input.profileId })
      : null;
    const row = {
      profileId: input.profileId,
      type: input.type,
      blockId: input.type === "click" ? input.blockId : null,
      visitorHash: hash,
      referrerHost: input.type === "view" ? referrerHost(input.referrer, new URL(e.APP_URL).hostname) : null,
      device: deviceCategory(userAgent),
      source: input.type === "view" ? (input.source ?? null) : null,
    };
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_LOCK_CLASS}::int, hashtext(${input.profileId}::text))`);
      const atLeast = async (where: ReturnType<typeof sql>, n: number) => {
        const [r] = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n from (select 1 from analytics_events where ${where} limit ${n}) s`,
        );
        return r.n >= n;
      };
      if (hash && input.type === "view") {
        const repeat = sql`profile_id = ${input.profileId} and type = 'view' and visitor_hash = ${hash}
          and occurred_at > now() - make_interval(mins => ${REPEAT_VIEW_MINUTES}::int)`;
        if (await atLeast(repeat, 1)) return "repeat";
      }
      const lastMinute = sql`occurred_at > now() - interval '1 minute'`;
      if (hash) {
        const visitor = sql`profile_id = ${input.profileId} and type in ('view', 'click') and visitor_hash = ${hash} and ${lastMinute}`;
        if (await atLeast(visitor, limits.perVisitor)) return "rate_limited";
      }
      if (await atLeast(sql`profile_id = ${input.profileId} and ${lastMinute}`, limits.perProfile)) return "rate_limited";
      if (await atLeast(lastMinute, limits.global)) return "rate_limited";
      await tx.insert(analyticsEvents).values(row);
      return "recorded";
    });
  } catch (err) {
    logger.warn({ errCode: errorCode(err), eventType: input.type }, "Analytics event not recorded");
    return "error";
  }
}

function errorCode(err: unknown): string {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  }
  return err instanceof Error ? err.name.slice(0, 40) : "unknown";
}
