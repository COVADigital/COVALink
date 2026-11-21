import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { CardExtras } from "@/components/cards/card-extras";
import { CardForm } from "@/components/cards/card-form";
import { EmailSetupNote, VerifyToCollectNote, VisitorAddressNote } from "@/components/email-setup-note";
import { profileLinks } from "@/components/section-links";
import { Skeleton } from "@/components/ui/skeleton";
import { cardTargetUrl } from "@/features/analytics/qr";
import { subscribeStatus } from "@/features/audience/status";
import { cardDisplayUrl, readCard } from "@/features/cards/card";
import { listOwnedProfiles } from "@/features/profiles/active";
import { getOwnedProfile } from "@/features/profiles/service";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Business card", robots: { index: false, follow: false } };

export default function CardPage({ params }: PageProps<"/dashboard/profiles/[id]/card">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-96 w-full max-w-5xl" />}>
      <Card params={params} />
    </Suspense>
  );
}

/** A profile's business card: name, address and QR code on a chosen colour. Owner only: any other id is a 404. */
async function Card({ params }: Pick<PageProps<"/dashboard/profiles/[id]/card">, "params">) {
  const user = await requireUser();
  const { id } = await params;
  let profile;
  try {
    profile = await getOwnedProfile(user.id, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const owned = await listOwnedProfiles(user.id);
  const sub = profileLinks(owned, (pid) => `/dashboard/profiles/${pid}/card`, profile.id);
  const { APP_URL } = env();
  const saved = readCard(profile.card, profile.draft.header.displayName);
  const status = await subscribeStatus();
  const admin = can(user.role, "admin.access");
  // Why card sign-ups can't run yet, if they can't: the same gates as Subscribe blocks.
  const shareBackNote = !status.emailReady ? (
    <EmailSetupNote admin={admin} />
  ) : !status.visitorsKnown ? (
    <VisitorAddressNote admin={admin} className="p-4" />
  ) : !status.subscribeEnabled ? (
    <p role="note" className="rounded-cl-md bg-cl-inset p-4 text-sm text-cl-ink-2">
      Sign-ups are turned off on this server, so the form stays hidden for now.
    </p>
  ) : !user.emailVerified ? (
    <VerifyToCollectNote className="p-4" />
  ) : undefined;

  return (
    <AppShell user={user} profileId={profile.id} current="card" sub={sub}>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Business card</h1>
          <p className="text-sm text-cl-ink-2">
            /{profile.handle} · Download it to print or share.
          </p>
        </div>
        {!profile.isPublished && (
          <p role="note" className="rounded-cl-md bg-cl-inset p-4 text-sm text-cl-ink-2">
            This profile isn&apos;t published, so the QR code opens a page that doesn&apos;t exist yet. Publish it before you share the card.
          </p>
        )}
        <CardForm
          profileId={profile.id}
          saved={saved}
          displayUrl={cardDisplayUrl(APP_URL, profile.handle)}
          qrTarget={cardTargetUrl(APP_URL, profile.handle)}
        />
        <CardExtras profileId={profile.id} saved={saved} shareBackNote={shareBackNote} />
        <p className="text-sm text-cl-ink-2">The QR code is tied to your handle. If you change the handle, download and share a new card.</p>
      </main>
    </AppShell>
  );
}
