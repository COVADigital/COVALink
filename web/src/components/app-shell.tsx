import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { ReactNode } from "react";
import { ActiveProfileSync } from "@/components/active-profile-sync";
import { workspaceLinks, type WorkspaceLink } from "@/components/editor/workspace-links";
import { WorkspaceMenu } from "@/components/editor/workspace-nav";
import { ProfileSwitcher } from "@/components/profile-switcher";
import { WorkspaceSidebar, type SectionLink } from "@/components/section-nav";
import { getActiveProfile } from "@/features/profiles/active";
import type { CurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";

/**
 * Dashboard shell, shared by every dashboard and administration page: the
 * expanded workspace sidebar from 75rem and a top bar with the same
 * destinations in a menu below that. The editor builds the same shell itself.
 * The COVALink tokens and the light/dark choice come from the route layout
 * (`ColorModeLayout`), not from this component.
 * `profileId`: the owned profile the page is about (checked by the page); it is shown as active and remembered.
 * `current`: the sidebar section the page belongs to; `sub` its pages, listed under it (`empty` when there are none).
 * `nav`: replaces the sidebar from 75rem (account settings shows its own sections there).
 */
export async function AppShell({
  user,
  profileId,
  current,
  sub,
  empty,
  nav,
  children,
}: {
  user: CurrentUser;
  profileId?: string;
  current?: WorkspaceLink["icon"];
  sub?: SectionLink[];
  empty?: string;
  nav?: ReactNode;
  children: ReactNode;
}) {
  const { active, all, sync } = await getActiveProfile(user.id, profileId);
  const links = workspaceLinks(can(user.role, "admin.access"), active?.id ?? null);
  return (
    <div className="flex min-h-dvh flex-1">
      {nav ?? <WorkspaceSidebar links={links} current={current} sub={sub} empty={empty} />}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* From 75rem the sidebar carries navigation, so the bar only holds the switcher. */}
        <header className={`border-b border-cl-line bg-cl-canvas ${all.length === 0 ? "ed-lg:hidden" : ""}`}>
          <div className="mx-auto flex min-h-14 w-full max-w-5xl items-center gap-2 px-4 py-2 sm:px-6">
            <WorkspaceMenu links={links} className="ed-lg:hidden" />
            <Link href="/dashboard" className="rounded-cl-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-cl-accent ed-lg:hidden">
              COVALink
            </Link>
            {all.length > 0 && (
              <div className="ml-auto">
                <ProfileSwitcher profiles={all.map(({ id, label, handle }) => ({ id, label, handle }))} activeId={active?.id ?? null} />
              </div>
            )}
          </div>
        </header>
        {children}
      </div>
      {sync && active && <ActiveProfileSync profileId={active.id} render={randomUUID()} />}
    </div>
  );
}
