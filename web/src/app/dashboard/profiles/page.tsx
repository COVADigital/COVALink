import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AppHeader } from "@/components/app-header";
import { ProfileStatusBadge } from "@/components/profile-status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listProfiles } from "@/features/profiles/service";
import { getSetting } from "@/features/settings/service";
import { requireUser } from "@/lib/auth/session";
import { CreateProfileForm } from "./create-profile-form";

export const metadata: Metadata = { title: "Profiles", robots: { index: false, follow: false } };

export default function ProfilesPage() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-40 w-full max-w-5xl" />}>
      <Profiles />
    </Suspense>
  );
}

async function Profiles() {
  const user = await requireUser();
  const [profiles, max] = await Promise.all([listProfiles(user.id), getSetting("profiles.maxPerUser")]);
  const atLimit = profiles.length >= max;
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Profiles</h1>
          <p className="text-sm text-muted-foreground">
            Each profile is a separate public page. {profiles.length} of {max} used.
          </p>
        </div>

        <section aria-labelledby="list-heading" className="grid gap-3">
          <h2 id="list-heading" className="sr-only">
            Your profiles
          </h2>
          {profiles.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No profiles yet. Create your first one below.</p>
          ) : (
            <ul className="grid gap-3">
              {profiles.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4" data-testid="profile-row">
                  <div className="grid min-w-0 gap-0.5">
                    <span className="font-medium">{p.label}</span>
                    <span className="truncate text-sm text-muted-foreground">/{p.handle}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ProfileStatusBadge isPublished={p.isPublished} hasUnpublishedChanges={p.hasUnpublishedChanges} />
                    {p.isPublished && (
                      <Button asChild size="sm" variant="ghost">
                        <a href={`/${p.handle}`} target="_blank" rel="noopener">
                          View page
                        </a>
                      </Button>
                    )}
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/dashboard/profiles/${p.id}`}>Edit</Link>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="create-heading" className="rounded-xl border bg-card p-5">
          <h2 id="create-heading" className="mb-4 text-sm font-medium">
            Create a profile
          </h2>
          <CreateProfileForm disabledReason={atLimit ? `You've reached the limit of ${max} profiles.` : undefined} />
        </section>
      </main>
    </>
  );
}
