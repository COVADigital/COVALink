import type { Metadata } from "next";
import { Suspense } from "react";
import { AccountNameForm } from "@/components/account/account-name-form";
import { ChangePasswordForm } from "@/components/account/change-password-form";
import { DeleteAccount } from "@/components/account/delete-account";
import { AppHeader } from "@/components/app-header";
import { Skeleton } from "@/components/ui/skeleton";
import { requireUser } from "@/lib/auth/session";

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

/** Session read per request behind Suspense (Cache Components); `requireUser` also refuses disabled accounts. */
async function Account() {
  const user = await requireUser();
  return (
    <>
      <AppHeader user={user} />
      <main className="mx-auto grid w-full max-w-2xl gap-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
          <p className="text-sm text-muted-foreground">Your sign-in details. Profiles are managed separately.</p>
        </div>
        <section aria-labelledby="name-heading" className="grid gap-4 rounded-xl border bg-card p-5">
          <h2 id="name-heading" className="text-sm font-medium">
            Account name
          </h2>
          <AccountNameForm name={user.name} />
        </section>
        <section aria-labelledby="email-heading" className="grid gap-2 rounded-xl border bg-card p-5 text-sm">
          <h2 id="email-heading" className="font-medium">
            Email
          </h2>
          <p className="break-all" data-testid="account-email">
            {user.email}{" "}
            <span className="text-muted-foreground">({user.emailVerified ? "verified" : "not verified"})</span>
          </p>
          <p className="text-muted-foreground">The email address can&apos;t be changed.</p>
        </section>
        <section aria-labelledby="password-heading" className="grid gap-4 rounded-xl border bg-card p-5">
          <h2 id="password-heading" className="text-sm font-medium">
            Change password
          </h2>
          <ChangePasswordForm />
        </section>
        <section aria-labelledby="delete-heading" className="grid gap-4 rounded-xl border border-destructive/30 bg-card p-5">
          <h2 id="delete-heading" className="text-sm font-medium">
            Delete account
          </h2>
          <DeleteAccount blockedReason={BLOCKED[user.role] ?? null} />
        </section>
      </main>
    </>
  );
}

function AccountSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-8 sm:px-6" aria-busy="true" aria-label="Loading account">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
