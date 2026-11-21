import { connection } from "next/server";
import { csvRow } from "@/features/audience/csv";
import { exportContacts } from "@/features/audience/service";
import { getOwnedProfile } from "@/features/profiles/service";
import { resolveSessionUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { csvResponseHeaders } from "@/lib/security/headers";

/**
 * The profile's confirmed contacts as a CSV download. Owner only, like the QR
 * download: the session comes from the request and the profile is looked up
 * through the owner-scoped service, so any other id is a 404.
 */
export async function GET(request: Request, { params }: RouteContext<"/dashboard/profiles/[id]/audience/export">) {
  await connection();
  const notFound = () => new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  const user = await resolveSessionUser(request.headers);
  if (!user) return notFound();
  let profile;
  try {
    profile = await getOwnedProfile(user.id, (await params).id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") return notFound();
    throw err;
  }
  const rows = await exportContacts(user.id, profile.id);
  const body = [
    csvRow(["email", "name", "phone", "note", "source", "confirmed_at", "consent_text"]),
    ...rows.map((r) => csvRow([r.email, r.name ?? "", r.phone ?? "", r.note ?? "", r.source, r.confirmedAt?.toISOString() ?? "", r.consentText])),
  ].join("\r\n");
  return new Response(`${body}\r\n`, { status: 200, headers: csvResponseHeaders(`${profile.handle}-contacts.csv`) });
}
