import { Download, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AppShell } from "@/components/app-shell";
import { ContactsTable } from "@/components/audience/contacts-table";
import { EmailSetupNote, VerifyToCollectNote, VisitorAddressNote } from "@/components/email-setup-note";
import { profileLinks } from "@/components/section-links";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listContacts } from "@/features/audience/service";
import { subscribeStatus } from "@/features/audience/status";
import { readCard } from "@/features/cards/card";
import { listOwnedProfiles } from "@/features/profiles/active";
import { getOwnedProfile } from "@/features/profiles/service";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";

export const metadata: Metadata = { title: "Audience", robots: { index: false, follow: false } };

export default function AudiencePage({ params }: PageProps<"/dashboard/profiles/[id]/audience">) {
  return (
    <Suspense fallback={<Skeleton className="mx-auto mt-8 h-64 w-full max-w-5xl" />}>
      <Audience params={params} />
    </Suspense>
  );
}

const DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

/**
 * The people who signed up through a profile's Subscribe block. Owner only:
 * the profile and its contacts are read through owner-scoped queries, so any
 * other id is a 404. Nothing here is cached.
 */
async function Audience({ params }: Pick<PageProps<"/dashboard/profiles/[id]/audience">, "params">) {
  const user = await requireUser();
  const { id } = await params;
  let profile;
  try {
    profile = await getOwnedProfile(user.id, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const [contacts, status, owned] = await Promise.all([listContacts(user.id, profile.id), subscribeStatus(), listOwnedProfiles(user.id)]);
  const sub = profileLinks(owned, (pid) => `/dashboard/profiles/${pid}/audience`, profile.id);
  const hasBlock = profile.draft.blocks.some((b) => b.type === "subscribe");
  // Sign-ups also come from the business card's share-back form.
  const collecting = hasBlock || readCard(profile.card, profile.draft.header.displayName).shareBack;
  const confirmed = contacts.filter((c) => c.status === "confirmed").length;
  const card = "grid gap-3 rounded-cl-lg border border-cl-line bg-cl-surface p-5";

  return (
    <AppShell user={user} profileId={profile.id} current="audience" sub={sub}>
      <main className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-8 sm:px-6">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Audience</h1>
          <p className="text-sm text-cl-ink-2">
            /{profile.handle} · {confirmed} confirmed {confirmed === 1 ? "contact" : "contacts"}
          </p>
        </div>

        {!status.emailReady && <EmailSetupNote admin={can(user.role, "admin.access")} />}
        {status.emailReady && !status.visitorsKnown && <VisitorAddressNote admin={can(user.role, "admin.access")} className="p-4" />}
        {status.emailReady && status.visitorsKnown && !status.subscribeEnabled && (
          <p role="note" className="rounded-cl-md bg-cl-inset p-4 text-sm text-cl-ink-2">
            Subscribe blocks are turned off on this server, so visitors can&apos;t sign up right now. Your contacts are kept.
          </p>
        )}
        {status.live && !user.emailVerified && <VerifyToCollectNote className="p-4" />}

        {!collecting ? (
          <section className={`${card} justify-items-start`} data-testid="audience-empty">
            <Users aria-hidden="true" className="size-6 text-cl-ink-2" />
            <h2 className="text-base font-medium">Collect subscribers on your page</h2>
            <p className="max-w-prose text-sm text-cl-ink-2">
              Add a Subscribe block, or turn on sharing details back on your business card, and visitors can leave their email address. Each one
              confirms by email before they appear here, and you can export the list to your own email tool.
            </p>
            {status.subscribeEnabled && (
              <Button asChild className="min-h-11 rounded-full sm:min-h-0">
                <Link href={`/dashboard/profiles/${profile.id}`}>Add a Subscribe block</Link>
              </Button>
            )}
          </section>
        ) : (
          !profile.isPublished && hasBlock && (
            <p role="note" className="rounded-cl-md bg-cl-inset p-4 text-sm text-cl-ink-2">
              This profile has a Subscribe block but isn&apos;t published. Publish it so visitors can sign up.
            </p>
          )
        )}

        {/* Mounted with or without contacts, so deleting the last one still announces it. */}
        <section aria-labelledby={contacts.length > 0 ? "contacts-heading" : undefined} className="grid gap-3">
          {contacts.length > 0 && (
            <h2 id="contacts-heading" className="text-base font-medium">
              Contacts
            </h2>
          )}
          <ContactsTable
            empty={collecting && <p className="text-sm text-cl-ink-2" data-testid="audience-none">No sign-ups yet.</p>}
            profileId={profile.id}
            contacts={contacts.map((c) => ({
              id: c.id,
              email: c.email,
              name: c.name,
              phone: c.phone,
              note: c.note,
              source: c.source,
              status: c.status,
              date: DATE.format(c.confirmedAt ?? c.createdAt),
            }))}
          />
        </section>

        {confirmed > 0 && (
          <p className="text-sm text-cl-ink-2">
            Need your list elsewhere?{" "}
            <a
              href={`/dashboard/profiles/${profile.id}/audience/export`}
              download
              className="inline-flex items-center gap-1 font-medium text-cl-ink underline underline-offset-4"
            >
              <Download aria-hidden="true" className="size-3.5" />
              Export CSV
            </a>{" "}
            (confirmed contacts only)
          </p>
        )}
      </main>
    </AppShell>
  );
}
