import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { ProfileStatusBadge } from "@/components/profile-status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getActiveProfile } from "@/features/profiles/active";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/permissions";

export const metadata: Metadata = { title: "Dashboard", robots: { index: false, follow: false } };

const ROLE_LABELS: Record<Role, string> = { super_admin: "Super administrator", admin: "Administrator", user: "User" };

export default function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}

/**
 * Reads the session per request (cookies) behind a Suspense boundary, as Cache
 * Components requires. Nothing here uses `use cache`, so user data is never
 * stored in a shared cache.
 */
async function Dashboard({ searchParams }: Pick<PageProps<"/dashboard">, "searchParams">) {
  const user = await requireUser();
  const { denied } = await searchParams;
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-8 sm:px-6">
        {denied && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            You don&apos;t have access to that page.
          </p>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.name}</h1>
          <p className="text-sm text-muted-foreground">Your account at a glance.</p>
        </div>
        <section aria-labelledby="account-heading" className="rounded-xl border bg-card p-5">
          <h2 id="account-heading" className="mb-4 text-sm font-medium">
            Account
          </h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted-foreground">Name</dt>
            <dd data-testid="user-name">{user.name}</dd>
            <dt className="text-muted-foreground">Email</dt>
            <dd data-testid="user-email" className="break-all">
              {user.email}{" "}
              {!user.emailVerified && <span className="text-xs text-muted-foreground">(unverified)</span>}
            </dd>
            <dt className="text-muted-foreground">Role</dt>
            <dd>
              <Badge variant="secondary" data-testid="user-role" data-role={user.role}>
                {ROLE_LABELS[user.role]}
              </Badge>
            </dd>
          </dl>
        </section>
        <ActiveProfileCard userId={user.id} />
      </main>
    </>
  );
}

async function ActiveProfileCard({ userId }: { userId: string }) {
  const { active, all } = await getActiveProfile(userId);
  return (
    <section aria-labelledby="profile-heading" className="rounded-xl border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="profile-heading" className="text-sm font-medium">
          Active profile
        </h2>
        <Link href="/dashboard/profiles" className="text-sm text-muted-foreground underline-offset-4 hover:underline">
          All profiles ({all.length})
        </Link>
      </div>
      {active ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <div className="grid gap-1">
            <span className="font-medium">{active.label}</span>
            <span className="text-muted-foreground">/{active.handle}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ProfileStatusBadge isPublished={active.isPublished} hasUnpublishedChanges={active.hasUnpublishedChanges} />
            <Button asChild size="sm">
              <Link href={`/dashboard/profiles/${active.id}`}>Edit profile</Link>
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 text-sm">
          <p className="text-muted-foreground">You don&apos;t have a profile yet. Create one to get your public page.</p>
          <Button asChild size="sm" className="w-fit">
            <Link href="/dashboard/profiles">Create a profile</Link>
          </Button>
        </div>
      )}
    </section>
  );
}

function DashboardSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-4 px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading dashboard">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
