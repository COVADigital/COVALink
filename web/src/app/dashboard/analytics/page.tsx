import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getActiveProfile } from "@/features/profiles/active";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Analytics", robots: { index: false, follow: false } };

export default function AnalyticsIndexPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-40 w-full max-w-5xl" />}>
      <AnalyticsIndex />
    </Suspense>
  );
}

/**
 * Opens the active profile's analytics. The active-profile cookie is only a
 * preference matched against the user's own profiles (`resolveActiveProfile`),
 * so a tampered or foreign id falls back to the user's first profile.
 */
async function AnalyticsIndex() {
  const user = await requireUser();
  const { active } = await getActiveProfile(user.id);
  if (active) redirect(`/dashboard/profiles/${active.id}/analytics`);
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <div className="grid gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid="analytics-no-profile">
          <p>Create and publish a profile to start seeing views and clicks.</p>
          <Button asChild size="sm" className="w-fit">
            <Link href="/dashboard/profiles">Create a profile</Link>
          </Button>
        </div>
      </main>
    </>
  );
}
