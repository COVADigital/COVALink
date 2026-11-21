import type { Metadata } from "next";
import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { AccountNameForm } from "@/components/account/account-name-form";
import { ACCOUNT_LINKS, type AccountSectionId } from "@/components/account/account-sections";
import { DeleteAccount } from "@/components/account/delete-account";
import { OwnedProfileMenu } from "@/components/account/owned-profile-menu";
import { PasswordRow } from "@/components/account/password-row";
import { SendVerification } from "@/components/account/send-verification";
import { AppShell } from "@/components/app-shell";
import { ProfileStatusBadge } from "@/components/profile-status-badge";
import { SectionChips, SectionRail } from "@/components/section-nav";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { listOwnedProfiles } from "@/features/profiles/active";
import { requireUser } from "@/lib/auth/session";
import { smtpConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Account", robots: { index: false, follow: false } };

export default function AccountPage() {
  return (
    <Suspense fallback={<AccountSkeleton />}>
      <Account />
    </Suspense>
  );
}

const BLOCKED: Record<string, string> = {
  super_admin: "The super administrator account can't be deleted.",
  admin: "Administrators can't delete their own account. Ask the super administrator to remove your administrator role first.",
};

const panel = "rounded-cl-lg border border-cl-line bg-cl-surface";
const card = `grid gap-4 p-5 ${panel}`;

/** A titled group of cards; `id` is the target of the settings nav. */
function Section({ id, title, description, children }: { id: AccountSectionId; title: string; description: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="grid scroll-mt-20 gap-3 ed-lg:scroll-mt-6">
      <div>
        <h2 id={`${id}-heading`} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-sm text-cl-ink-2">{description}</p>
      </div>
      {children}
    </section>
  );
}

/** Session read per request behind Suspense (Cache Components); `requireUser` also refuses disabled accounts. */
async function Account() {
  const user = await requireUser();
  const profiles = await listOwnedProfiles(user.id);
  return (
    <AppShell user={user} current="account" nav={<SectionRail label="Account settings" title="Account" links={ACCOUNT_LINKS} />}>
      <SectionChips label="Account settings" links={ACCOUNT_LINKS} />
      <main className="mx-auto grid w-full max-w-3xl gap-10 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="text-sm text-cl-ink-2">Your details, sign-in and the profiles you own.</p>
        </div>

        <Section id="personal" title="Personal" description="Manage your personal details and account information.">
          <div className={card}>
            <h3 className="text-sm font-medium">Your information</h3>
            <AccountNameForm
              name={user.name}
              email={
                <div className="grid gap-1.5">
                  <Label htmlFor="account-email">Email</Label>
                  <Input id="account-email" value={user.email} readOnly aria-describedby="account-email-note" className="h-11 bg-cl-inset sm:h-10" data-testid="account-email" />
                  <p id="account-email-note" className="text-sm text-cl-ink-2">
                    {user.emailVerified ? "Verified." : "Not verified."} The email address can&apos;t be changed.
                  </p>
                  {!user.emailVerified && smtpConfigured() && <SendVerification email={user.email} />}
                </div>
              }
            />
          </div>
        </Section>

        <Section id="security" title="Security" description="Keep your account protected.">
          <div className={card}>
            <PasswordRow />
          </div>
        </Section>

        <Section id="management" title="Account management" description="Manage your profiles and your account.">
          <div className={`grid ${panel}`}>
            <h3 className="px-5 pt-5 pb-2 text-sm font-medium">Profiles you own</h3>
            {profiles.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-cl-ink-2">
                You don&apos;t have a profile yet.{" "}
                <Link href="/dashboard/profiles" className="font-medium text-cl-ink underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-cl-accent">
                  Create one
                </Link>
              </p>
            ) : (
              <ul className="divide-y divide-cl-line border-t border-cl-line">
                {profiles.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-3" data-testid="owned-profile">
                    <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-cl-ink font-semibold text-cl-surface">
                      {p.label.charAt(0).toUpperCase()}
                    </span>
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="truncate font-medium">{p.label}</span>
                      <span className="truncate text-sm text-cl-ink-2">/{p.handle}</span>
                    </div>
                    <ProfileStatusBadge isPublished={p.isPublished} hasUnpublishedChanges={p.hasUnpublishedChanges} />
                    <OwnedProfileMenu id={p.id} label={p.label} handle={p.handle} />
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-1.5 border-t border-cl-line p-5">
              <h4 className="text-sm font-medium">Admins</h4>
              <p className="flex flex-wrap items-center justify-between gap-2 rounded-cl-md bg-cl-inset px-3 py-2 text-sm">
                <span className="min-w-0 break-all">{user.email}</span>
                <span className="text-cl-ink-2">Owner (you)</span>
              </p>
            </div>
          </div>

          <div id="danger" className={`${card} scroll-mt-20 ed-lg:scroll-mt-6`}>
            <h3 className="text-sm font-medium">Manage account deletion</h3>
            <DeleteAccount blockedReason={BLOCKED[user.role] ?? null} />
          </div>
        </Section>
      </main>
    </AppShell>
  );
}

function AccountSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-4 px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading account">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
