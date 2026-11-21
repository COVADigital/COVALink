import { connection } from "next/server";
import { handleCardVcard, vcardMethodNotAllowed } from "@/features/profiles/vcard-download";

/** Public download of the business card's contact details (features/profiles/vcard-download.ts). HEAD shares the handler. */
async function download(request: Request, { params }: RouteContext<"/api/vcard/[profileId]/card">) {
  await connection();
  return handleCardVcard(request, (await params).profileId);
}

export const GET = download;
export const HEAD = download;
export const POST = vcardMethodNotAllowed;
export const PUT = vcardMethodNotAllowed;
export const PATCH = vcardMethodNotAllowed;
export const DELETE = vcardMethodNotAllowed;
export const OPTIONS = vcardMethodNotAllowed;
