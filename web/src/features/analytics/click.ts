import "server-only";
import { z } from "zod";
import type { Block } from "@/features/blocks/block";
import { isRenderableBlockType } from "@/features/blocks/definitions";
import { socialDestination } from "@/features/blocks/social-platforms";
import { getLiveProfileById, getPublishedDocument } from "@/features/profiles/public";
import { parseLinkUrl } from "@/lib/validation/url";
import { recordEvent, type EventOutcome } from "./ingest";

/**
 * `GET /go/{profileId}/{blockId}`: tracked navigation for published link
 * blocks and linked image blocks. The destination always
 * comes from the profile's *current* published document, never from the
 * request: the profile must be live (published, owner present and not
 * banned), the block must be a visible, valid link block, or image block with
 * a link, in it, and its stored URL is revalidated with the link-write rules.
 * Every other case is the same 404. The redirect is temporary and
 * uncacheable, so unpublish, edits and bans apply at once.
 *
 * A GET's click is recorded before redirecting, within `CLICK_RECORD_DEADLINE_MS`;
 * HEAD gets the same validation and response and is never recorded.
 * Rate limits, filters (bots, prefetches, the owner) and storage failures
 * only decide whether a click is stored; they never block a valid redirect.
 */

export const CLICK_RECORD_DEADLINE_MS = 300;

const uuid = z.uuid();

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

export interface ClickDeps {
  record: (input: Parameters<typeof recordEvent>[0]) => Promise<EventOutcome>;
  deadlineMs: number;
}

/** A visible, reviewed block of a live profile's current published document, or null. */
async function publishedBlock(profileId: string, blockId: string) {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(blockId).success) return null;
  const live = await getLiveProfileById(profileId);
  if (!live) return null;
  const published = await getPublishedDocument(live);
  const block = published?.blocks.find((b) => b.id === blockId);
  if (!block || !block.visible || !isRenderableBlockType(block.type)) return null;
  return { live, block };
}

async function navigate(
  request: Request,
  live: { id: string; ownerId: string },
  blockId: string,
  destination: URL,
  deps: Partial<ClickDeps>,
): Promise<Response> {
  // Only a GET navigation is a click. HEAD (link checkers, previews,
  // monitors; Next.js would also answer it through GET) is validated and
  // redirected identically but never recorded.
  if (request.method === "GET") {
    const record = deps.record ?? recordEvent;
    await withDeadline(
      record({ type: "click", profileId: live.id, ownerId: live.ownerId, blockId, headers: request.headers }),
      deps.deadlineMs ?? CLICK_RECORD_DEADLINE_MS,
    );
  }
  return new Response(null, {
    status: 302,
    headers: { location: destination.toString(), "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
  });
}

/** The revalidated destination of a link block or a linked (never decorative) image block. */
function blockDestination(block: Block): URL | null {
  if (block.type === "link") return parseLinkUrl(block.config.url);
  if (block.type === "image" && block.config.href && !block.config.decorative) return parseLinkUrl(block.config.href);
  return null;
}

export async function handleClick(
  request: Request,
  profileId: string,
  blockId: string,
  deps: Partial<ClickDeps> = {},
): Promise<Response> {
  const found = await publishedBlock(profileId, blockId);
  const destination = found ? blockDestination(found.block) : null;
  if (!found || !destination) return notFound();
  return navigate(request, found.live, found.block.id, destination, deps);
}

/** A canonical item index: `0`, or 1–99 without a leading zero (blocks hold at most 24 items). */
const ITEM_INDEX = /^(0|[1-9][0-9]?)$/;

/**
 * `GET /go/{profileId}/{blockId}/{index}`: one item of a
 * visible social block in the current published document. The stored
 * destination is revalidated with `socialDestination`. The click is
 * recorded against the block (aggregated per block; no per-item analytics).
 * Every other case is the same 404, with nothing recorded.
 */
export async function handleSocialClick(
  request: Request,
  profileId: string,
  blockId: string,
  index: string,
  deps: Partial<ClickDeps> = {},
): Promise<Response> {
  if (!ITEM_INDEX.test(index)) return notFound();
  const found = await publishedBlock(profileId, blockId);
  if (found?.block.type !== "social") return notFound();
  const item = found.block.config.items[Number(index)];
  const destination = item ? socialDestination(item.platform, item.url) : null;
  if (!destination) return notFound();
  return navigate(request, found.live, found.block.id, destination, deps);
}

/** Waits for `work` at most `ms`; never rejects (a late result is ignored). */
async function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
