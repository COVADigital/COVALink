import { connection } from "next/server";
import { qrFileName, qrSvg, qrTargetUrl } from "@/features/analytics/qr";
import { getOwnedProfile } from "@/features/profiles/service";
import { resolveSessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { qrResponseHeaders } from "@/lib/security/headers";

/**
 * The profile's QR code as an SVG download. Owner only: the session
 * is resolved from the request and the profile is looked up through the
 * owner-scoped service, so any other id is a 404.
 */
export async function GET(request: Request, { params }: RouteContext<"/dashboard/profiles/[id]/qr">) {
  await connection();
  const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  const user = await resolveSessionUser(request.headers);
  if (!user) return notFound();
  let profile;
  try {
    profile = await getOwnedProfile(user.id, (await params).id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return notFound();
    throw err;
  }
  return new Response(qrSvg(qrTargetUrl(env().APP_URL, profile.handle)), {
    status: 200,
    headers: qrResponseHeaders(qrFileName(profile.handle)),
  });
}
