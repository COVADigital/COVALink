import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { CardWelcome } from "@/components/profile/card-welcome";
import { ProfileView } from "@/components/profile/profile-view";
import { ViewBeacon } from "@/components/profile/view-beacon";
import { resolveHandleParam } from "@/features/profiles/handle";
import { buildProfileMetadata } from "@/features/profiles/metadata";
import { getLiveProfile, getPublishedDocument } from "@/features/profiles/public";
import { ownerVerified, subscribeStatus } from "@/features/audience/status";
import { getCard } from "@/features/cards/service";
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
  const hasSubscribe = published.blocks.some((b) => b.type === "subscribe" && b.visible);
  const card = await getCard(live.id, published.header.displayName);
  // Sign-ups (Subscribe blocks and the card's share-back form) need email, a trusted client address, the admin setting and a verified owner.
  const signupsLive = (hasSubscribe || card.shareBack) && (await subscribeStatus()).live && (await ownerVerified(live.ownerId));
  // Only switches and the card's name reach the page, and only while an extra is on; contact details are served by the card's vCard route.
  const shareBack = card.shareBack && signupsLive;
  const saveContact = card.saveContact && !!card.contact;
  const intro =
    shareBack || saveContact ? <CardWelcome profileId={live.id} name={card.displayName} shareBack={shareBack} saveContact={saveContact} /> : null;
  return (
    <>
      <ProfileView
        document={published}
        verified={live.verified}
        mode="public"
        clickTrackingProfileId={live.id}
        subscribeLive={hasSubscribe && signupsLive}
        intro={intro}
      />
      {/* Analytics: one view beacon after hydration; link blocks go through /go. */}
      <ViewBeacon profileId={live.id} />
    </>
  );
}
