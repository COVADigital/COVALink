import Link from "next/link";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { ProfileSwitcher } from "@/components/profile-switcher";
import { getActiveProfile } from "@/features/profiles/active";
import type { CurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";

const navLink = "rounded-md px-1 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** Dashboard header. A full sidebar application shell isn't implemented. */
export async function AppHeader({ user }: { user: CurrentUser }) {
  const { active, all } = await getActiveProfile(user.id);
  return (
    <header className="border-b bg-background">
      <div className="mx-auto flex min-h-14 w-full max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
        <nav aria-label="Main" className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <Link href="/dashboard" className="font-semibold tracking-tight">
            COVALink
          </Link>
          <Link href="/dashboard/profiles" className={navLink}>
            Profiles
          </Link>
          <Link href="/dashboard/analytics" className={navLink}>
            Analytics
          </Link>
          <Link href="/dashboard/account" className={navLink}>
            Account
          </Link>
          {can(user.role, "admin.access") && (
            <Link href="/admin" className={navLink}>
              Administration
            </Link>
          )}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          {all.length > 0 && (
            <ProfileSwitcher profiles={all.map(({ id, label, handle }) => ({ id, label, handle }))} activeId={active?.id ?? null} />
          )}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
