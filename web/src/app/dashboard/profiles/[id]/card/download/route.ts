import { connection } from "next/server";
import { cardTargetUrl } from "@/features/analytics/qr";
import { CARD_FILE_NAME, cardDisplayUrl, cardSvg, readCard } from "@/features/cards/card";
import { getOwnedProfile } from "@/features/profiles/service";
import { resolveSessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { qrResponseHeaders } from "@/lib/security/headers";

/** The profile's business card as an SVG download, from the saved settings. Owner only, like the QR route: any other id is a 404. */
export async function GET(request: Request, { params }: RouteContext<"/dashboard/profiles/[id]/card/download">) {
  await connection();
  const notFound = () =>
    new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  const user = await resolveSessionUser(request.headers);
  if (!user) return notFound();
  let profile;
  try {
    profile = await getOwnedProfile(user.id, (await params).id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return notFound();
    throw err;
  }
  const { APP_URL } = env();
  const card = readCard(profile.card, profile.draft.header.displayName);
  const svg = cardSvg({ ...card, displayUrl: cardDisplayUrl(APP_URL, profile.handle), qrTarget: cardTargetUrl(APP_URL, profile.handle) });
  return new Response(svg, { status: 200, headers: qrResponseHeaders(CARD_FILE_NAME(profile.handle)) });
}
