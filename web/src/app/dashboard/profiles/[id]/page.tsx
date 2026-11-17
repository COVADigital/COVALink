import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ActiveProfileSync } from "@/components/active-profile-sync";
import { workspaceLinks } from "@/components/editor/workspace-links";
import { WorkspaceRail } from "@/components/editor/workspace-nav";
import { ProfileSwitcher } from "@/components/profile-switcher";
import { Skeleton } from "@/components/ui/skeleton";
import { listMedia } from "@/features/media/service";
import { getActiveProfile } from "@/features/profiles/active";
import { getOwnedProfile } from "@/features/profiles/service";
import { can } from "@/lib/auth/permissions";
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
  // As in the dashboard header: the profile being edited is shown as active and remembered.
  const { active, all, sync } = await getActiveProfile(user.id, profile.id);
  const links = workspaceLinks(can(user.role, "admin.access"), active?.id ?? null);
  // The editor builds its own shell (its top bar holds Save/Publish); other pages use AppShell.
  return (
    <div className="editor-scope flex min-h-dvh flex-1">
      <WorkspaceRail links={links} current="profiles" />
      {/* Keyed by id only: actions that evict cache tags also refresh this route, and
          the editor's local state (revision, status) must survive that refresh. */}
      <ProfileEditor
        key={profile.id}
        links={links}
        label={profile.label}
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
          incomplete: profile.incomplete,
          appearance: profile.appearance,
          media,
        }}
        switcher={
          all.length > 1 ? (
            <ProfileSwitcher
              profiles={all.map(({ id, label, handle }) => ({ id, label, handle }))}
              activeId={active?.id ?? null}
              triggerClassName="h-10 data-[size=sm]:h-10 max-ed-lg:h-11 max-ed-lg:data-[size=sm]:h-11"
            />
          ) : null
        }
        manage={
          <>
            <ProfileSettingsForm profileId={profile.id} handle={profile.handle} label={profile.label} />
            <DangerZone profileId={profile.id} handle={profile.handle} />
          </>
        }
      />
      {sync && active && <ActiveProfileSync profileId={active.id} render={randomUUID()} />}
    </div>
  );
}
