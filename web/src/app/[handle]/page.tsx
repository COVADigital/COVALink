import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { ProfileView } from "@/components/profile/profile-view";
import { ViewBeacon } from "@/components/profile/view-beacon";
import { resolveHandleParam } from "@/features/profiles/handle";
import { buildProfileMetadata } from "@/features/profiles/metadata";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import { getSetting } from "@/features/settings/service";
import { env } from "@/lib/env";

/**
 * Public profile at /{handle}. Resolution and the live check run before
 * anything streams, so unknown/unpublished/banned handles get a real 404 and
 * cosmetic variants (@handle, uppercase) a real 308. Only the published
 * snapshot is rendered.
 *
 * `instant = false` lets this route block on the server instead of streaming a
 * static shell: a streamed notFound()/redirect() can't change the HTTP status
 * (Next.js streaming "HTTP contract"), and crawlers should get complete HTML.
 */
export const instant = false;
async function load(segment: string) {
  const resolved = resolveHandleParam(segment);
  if (resolved.kind === "redirect") permanentRedirect(`/${resolved.handle}`);
  if (resolved.kind === "not_found") notFound();
  const live = await getLiveProfile(resolved.handle);
  if (!live) notFound();
  const published = await getPublishedDocument(live);
  if (!published) notFound();
  return { live, published };
}

export async function generateMetadata({ params }: PageProps<"/[handle]">): Promise<Metadata> {
  const { live, published } = await load((await params).handle);
  return buildProfileMetadata({
    published,
    handle: live.handle,
    appUrl: env().APP_URL,
    siteName: await getSetting("site.name"),
  });
}

export default async function PublicProfilePage({ params }: PageProps<"/[handle]">) {
  const { live, published } = await load((await params).handle);
  return (
    <>
      <ProfileView document={published} verified={live.verified} mode="public" clickTrackingProfileId={live.id} />
      {/* Analytics: one view beacon after hydration; link blocks go through /go. */}
      <ViewBeacon profileId={live.id} />
    </>
  );
}
