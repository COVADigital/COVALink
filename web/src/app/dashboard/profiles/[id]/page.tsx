import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listMedia } from "@/features/media/service";
import { getOwnedProfile } from "@/features/profiles/service";
import { requireUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { DangerZone } from "./danger-zone";
import { ProfileEditor } from "./profile-editor";
import { ProfileSettingsForm } from "./profile-settings-form";

export const metadata: Metadata = { title: "Edit profile", robots: { index: false, follow: false } };

export default function EditProfilePage({ params }: PageProps<"/dashboard/profiles/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-96 w-full max-w-5xl" />}>
      <Editor params={params} />
    </Suspense>
  );
}

async function Editor({ params }: Pick<PageProps<"/dashboard/profiles/[id]">, "params">) {
  const user = await requireUser();
  const { id } = await params;
  let profile;
  try {
    profile = await getOwnedProfile(user.id, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  // The editor still works without the library; it shows a retry instead.
  const media = await listMedia(user.id).catch((err) => {
    logger.error({ err, userId: user.id }, "Loading the media library failed");
    return null;
  });
  return (
    <>
      <AppHeader user={user} profileId={profile.id} />
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6">
        <div className="grid gap-1">
          <Link href="/dashboard/profiles" className="w-fit text-sm text-muted-foreground underline-offset-4 hover:underline">
            ← All profiles
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">{profile.label}</h1>
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
            <span data-testid="editor-handle">/{profile.handle}</span>
            <Link href={`/dashboard/profiles/${profile.id}/analytics`} className="underline-offset-4 hover:underline">
              Analytics and QR code
            </Link>
          </p>
        </div>
        {/* Keyed by id only: actions that evict cache tags also refresh this route, and
            the editor's local state (revision, status) must survive that refresh. */}
        <ProfileEditor
          key={profile.id}
          profile={{
            id: profile.id,
            handle: profile.handle,
            verified: profile.verified,
            isPublished: profile.isPublished,
            everPublished: profile.publishedRevision !== null,
            hasUnpublishedChanges: profile.hasUnpublishedChanges,
            revision: profile.draftRevision,
            draft: profile.draft,
            protectedBlocks: profile.protectedBlocks,
            appearance: profile.appearance,
            media,
          }}
        />
        <ProfileSettingsForm profileId={profile.id} handle={profile.handle} label={profile.label} />
        <DangerZone profileId={profile.id} handle={profile.handle} />
      </main>
    </>
  );
}
