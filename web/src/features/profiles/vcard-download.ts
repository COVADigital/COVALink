import "server-only";
import { z } from "zod";
import { buildVCard, vcardFileNames } from "@/features/blocks/vcard";
import { getLiveProfileById, getPublishedDocument } from "@/features/profiles/public";
import { vcardResponseHeaders } from "@/lib/security/headers";

/**
 * `GET`/`HEAD /api/vcard/{profileId}/{blockId}`: the vCard of a
 * visible contact block in a live profile's *current* published document.
 * Draft-only, hidden, unpublished, banned-owner, unknown, malformed,
 * other-profile, other-type and invalid cases are all the same plain 404.
 * Nothing is recorded (contact downloads aren't counted), and no cookie is
 * set. HEAD returns the GET status and headers without a body.
 */

const uuid = z.uuid();
const encoder = new TextEncoder();

function respond(request: Request, status: number, body: string, headers: Record<string, string>): Response {
  const bytes = encoder.encode(body);
  return new Response(request.method === "HEAD" ? null : bytes, {
    status,
    headers: { ...headers, "content-length": String(bytes.length) },
  });
}

const notFound = (request: Request) => respond(request, 404, "Not found", vcardResponseHeaders());

/** The only methods the route serves. */
export const VCARD_METHODS = "GET, HEAD";

/**
 * Every other HTTP method the route can declare (POST, PUT, PATCH, DELETE,
 * OPTIONS): 405 with `Allow: GET, HEAD` and the route's headers, the same for
 * any ids. Next.js would otherwise answer with a bare 405, or 204
 * for OPTIONS, outside `handleVcard`.
 */
export function vcardMethodNotAllowed(): Response {
  const body = encoder.encode("Method not allowed");
  return new Response(body, {
    status: 405,
    headers: { ...vcardResponseHeaders(), allow: VCARD_METHODS, "content-length": String(body.length) },
  });
}

export async function handleVcard(request: Request, profileId: string, blockId: string): Promise<Response> {
  if (!uuid.safeParse(profileId).success || !uuid.safeParse(blockId).success) return notFound(request);
  const live = await getLiveProfileById(profileId);
  if (!live) return notFound(request);
  const published = await getPublishedDocument(live);
  const block = published?.blocks.find((b) => b.id === blockId);
  if (!block || block.type !== "contact" || !block.visible) return notFound(request);
  const card = buildVCard(block.config);
  if (!card) return notFound(request);
  return respond(request, 200, card, vcardResponseHeaders(vcardFileNames(block.config)));
}
