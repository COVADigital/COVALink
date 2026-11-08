import { connection } from "next/server";
import { handleVcard, vcardMethodNotAllowed } from "@/features/profiles/vcard-download";

/**
 * Public contact-card download (features/profiles/vcard-download.ts).
 * HEAD shares the handler. Every other method Next.js routes here is answered
 * explicitly with 405 and the route's headers.
 */
async function download(request: Request, { params }: RouteContext<"/api/vcard/[profileId]/[blockId]">) {
  await connection();
  const { profileId, blockId } = await params;
  return handleVcard(request, profileId, blockId);
}

export const GET = download;
export const HEAD = download;
export const POST = vcardMethodNotAllowed;
export const PUT = vcardMethodNotAllowed;
export const PATCH = vcardMethodNotAllowed;
export const DELETE = vcardMethodNotAllowed;
export const OPTIONS = vcardMethodNotAllowed;
