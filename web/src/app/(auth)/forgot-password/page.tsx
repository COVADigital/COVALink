import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { env, smtpConfigured } from "@/lib/env";
import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata: Metadata = { title: "Forgot password", robots: { index: false, follow: false } };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Forgot your password?</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <ResetAvailability />
      </Suspense>
    </>
  );
}

/**
 * Without SMTP a production server can't send the link, so the page says who
 * can help instead of pretending to send mail. Development keeps the
 * form: its mail is written to the server log. Read per request.
 */
async function ResetAvailability() {
  await connection();
  if (!smtpConfigured() && env().NODE_ENV === "production") {
    return (
      <div className="grid gap-4 text-sm">
        <p role="status" data-testid="reset-unavailable">
          This installation can&apos;t send email, so passwords can&apos;t be reset by link. Ask your administrator to reset access to your account.
        </p>
        <Link href="/login" className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }
  return <ForgotPasswordForm />;
}
