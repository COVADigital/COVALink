import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { registrationDecision } from "@/features/setup/registration";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Create account</h1>
      <p className="mb-6 text-sm text-muted-foreground">Set up your COVALink account.</p>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <RegistrationGate />
      </Suspense>
    </>
  );
}

/**
 * Shows the form only when sign-up is open. This is a courtesy: the Better
 * Auth `user.create.before` hook enforces the same policy on every request.
 * `connection()` makes the decision a per-request read: it is never
 * prerendered at build time (no database there) or cached across requests.
 */
async function RegistrationGate() {
  await connection();
  const decision = await registrationDecision();
  if (!decision.allowed) {
    return (
      <div className="grid gap-4 text-sm">
        <p role="status">{decision.message}</p>
        <Link href="/login" className="font-medium underline-offset-4 hover:underline">
          Go to sign in
        </Link>
      </div>
    );
  }
  return <RegisterForm />;
}
