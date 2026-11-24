import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getActiveProfile } from "@/features/profiles/active";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Business card", robots: { index: false, follow: false } };

export default function CardIndexPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-40 w-full max-w-5xl" />}>
      <CardIndex />
    </Suspense>
  );
}

/** Opens the active profile's business card, like the Audience index. */
async function CardIndex() {
  const user = await requireUser();
  const { active } = await getActiveProfile(user.id);
  if (active) redirect(`/dashboard/profiles/${active.id}/card`);
  return (
    <AppShell user={user} current="card" empty="No profiles yet.">
      <main className="mx-auto grid w-full max-w-5xl gap-4 px-4 py-8 sm:px-6">
        <h1 className="text-2xl font-semibold tracking-tight">Business card</h1>
        <div className="grid gap-3 rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid="card-no-profile">
          <p>Create a profile to get a business card with your page&apos;s QR code.</p>
          <Button asChild size="sm" className="w-fit">
            <Link href="/dashboard/profiles">Create a profile</Link>
          </Button>
        </div>
      </main>
    </AppShell>
  );
}
