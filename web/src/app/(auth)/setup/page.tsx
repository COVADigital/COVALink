import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { isBootstrapped, setupEnabled } from "@/features/setup/service";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up", robots: { index: false, follow: false } };

export default function SetupPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Set up COVALink</h1>
      <p className="mb-6 text-sm text-muted-foreground">Create the administrator account for this server.</p>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <SetupState />
      </Suspense>
    </>
  );
}

/** Per-request (`connection()`): installation state is never prerendered or cached. */
async function SetupState() {
  await connection();
  if (await isBootstrapped()) {
    return (
      <div className="grid gap-3 text-sm">
        <p role="status">This server is already set up.</p>
        <Link href="/login" className="font-medium underline-offset-4 hover:underline">
          Sign in
        </Link>
      </div>
    );
  }
  if (!setupEnabled()) {
    return (
      <div className="grid gap-2 text-sm" role="status">
        <p>Setup is disabled.</p>
        <p className="text-muted-foreground">
          Set <code>SETUP_TOKEN</code> (32+ random characters) in the server environment, restart the app and reload this page.
        </p>
      </div>
    );
  }
  return <SetupForm />;
}
