import "server-only";
import { z } from "zod";
import { getLiveProfileById } from "@/features/profiles/public";
import { env } from "@/lib/env";
import { isSameOrigin } from "@/lib/security/origin";
import { MAX_REFERRER_INPUT, parseSource } from "./classify";
import { recordEvent } from "./ingest";

/**
 * `POST /api/v`: the profile-view beacon. The body is a small JSON
 * object, `{"p": profileId, "s"?: source, "r"?: document.referrer}`; nothing
 * else is accepted. Only same-origin requests from COVALink's own pages
 * (Origin and Fetch Metadata) with a JSON content type get past the first
 * checks, so a cross-site form or image can't post one. Every outcome after
 * validation (recorded, discarded, unknown or unpublished profile, storage
 * error) is the same empty 204, and no cookie is ever set.
 */

export const MAX_BEACON_BYTES = 4096;

const beaconSchema = z
  .object({
    p: z.uuid(),
    // Ignored unless allowlisted (`parseSource`).
    s: z.string().max(16).optional(),
    r: z.string().max(MAX_REFERRER_INPUT).optional(),
  })
  .strict();

const reply = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

export interface BeaconDeps {
  record: typeof recordEvent;
}

export async function handleViewBeacon(request: Request, deps: Partial<BeaconDeps> = {}): Promise<Response> {
  const record = deps.record ?? recordEvent;
  if (!isSameOrigin(request, new URL(env().APP_URL).origin)) return reply(403);
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get("content-type") ?? "")) return reply(415);
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,7}$/.test(declared) || Number(declared) > MAX_BEACON_BYTES)) return reply(413);
  const text = await readBounded(request, MAX_BEACON_BYTES);
  if (text === null) return reply(413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400);
  }
  const parsed = beaconSchema.safeParse(body);
  if (!parsed.success) return reply(400);
  const live = await getLiveProfileById(parsed.data.p).catch(() => null);
  if (live) {
    await record({
      type: "view",
      profileId: live.id,
      ownerId: live.ownerId,
      headers: request.headers,
      source: parseSource(parsed.data.s),
      referrer: parsed.data.r ?? null,
    });
  }
  return reply(204);
}

/** The body as text, or null when it exceeds `max` bytes (reading stops there). */
async function readBounded(request: Request, max: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
