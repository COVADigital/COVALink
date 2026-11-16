/** Workspace destinations for the dashboard shell and the editor. Plain data, so server and client can both use it. */
export interface WorkspaceLink {
  href: string;
  label: string;
  icon: "profiles" | "analytics" | "account" | "admin";
}

/** Like the dashboard header, Analytics opens the active profile's own analytics. */
export function workspaceLinks(canAdmin: boolean, activeProfileId: string | null): WorkspaceLink[] {
  return [
    { href: "/dashboard/profiles", label: "Profiles", icon: "profiles" },
    {
      href: activeProfileId ? `/dashboard/profiles/${activeProfileId}/analytics` : "/dashboard/analytics",
      label: "Analytics",
      icon: "analytics",
    },
    { href: "/dashboard/account", label: "Account", icon: "account" },
    ...(canAdmin ? [{ href: "/admin", label: "Administration", icon: "admin" } as const] : []),
  ];
}
