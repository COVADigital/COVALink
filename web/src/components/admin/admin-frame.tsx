import Link from "next/link";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/app-header";
import { Skeleton } from "@/components/ui/skeleton";
import { can, type Capability } from "@/lib/auth/permissions";
import type { CurrentUser } from "@/lib/auth/session";

/**
 * Shared shell of the administration pages: a skip link, the
 * dashboard header, the admin section navigation and the main landmark. The
 * navigation shows only sections the user's role can open; every page also
 * enforces its own capability, and every service enforces it again.
 */

export type AdminSection = "overview" | "users" | "settings" | "audit";

const SECTIONS: { id: AdminSection; href: string; label: string; capability: Capability }[] = [
  { id: "overview", href: "/admin", label: "Overview", capability: "admin.access" },
  { id: "users", href: "/admin/users", label: "Users", capability: "users.view" },
  { id: "settings", href: "/admin/settings", label: "Settings", capability: "settings.manage" },
  { id: "audit", href: "/admin/audit", label: "Audit log", capability: "audit.view" },
];

export { DESTRUCTIVE_OUTLINE, TOUCH } from "./styles";

export function AdminFrame({ user, section, children }: { user: CurrentUser; section: AdminSection; children: ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus-visible:outline-2 focus-visible:outline-ring"
      >
        Skip to main content
      </a>
      <AppHeader user={user} />
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <nav aria-label="Administration" className="-mx-1 overflow-x-auto">
          <ul className="flex min-w-max gap-1 px-1">
            {SECTIONS.filter((s) => can(user.role, s.capability)).map((s) => (
              <li key={s.id}>
                <Link
                  href={s.href}
                  aria-current={s.id === section ? "page" : undefined}
                  className={`inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:min-h-9 ${
                    s.id === section ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1} className="grid min-w-0 gap-6 outline-none">
          {children}
        </main>
      </div>
    </>
  );
}

export function AdminSkeleton({ label }: { label: string }) {
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6" aria-busy="true" aria-label={label} data-testid="admin-loading">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function AdminError({ message, retryHref }: { message: string; retryHref: string }) {
  return (
    <div role="alert" className="grid gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm" data-testid="admin-error">
      <p>{message}</p>
      <Link href={retryHref} className="w-fit underline underline-offset-4">
        Try again
      </Link>
    </div>
  );
}

export function PageTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="grid gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-pretty text-muted-foreground">{description}</p>}
    </div>
  );
}
