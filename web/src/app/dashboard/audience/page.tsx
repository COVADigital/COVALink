import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getActiveProfile } from "@/features/profiles/active";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Audience", robots: { index: false, follow: false } };

export default function AudienceIndexPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-40 w-full max-w-5xl" />}>
      <AudienceIndex />
    </Suspense>
  );
}

/** Opens the active profile's audience, like the Analytics index. */
async function AudienceIndex() {
  const user = await requireUser();
  const { active } = await getActiveProfile(user.id);
  if (active) redirect(`/dashboard/profiles/${active.id}/audience`);
  return (
    <AppShell user={user} current="audience" empty="No profiles yet.">
      <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Audience</h1>
        <div className="grid gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid="audience-no-profile">
          <p>Create a profile and add a Subscribe block to start collecting email addresses.</p>
          <Button asChild size="sm" className="w-fit">
            <Link href="/dashboard/profiles">Create a profile</Link>
          </Button>
        </div>
      </main>
    </AppShell>
  );
}
