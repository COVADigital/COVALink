import type { Metadata } from "next";
import { ResetPasswordForm } from "./reset-password-form";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The token arrives in the link fragment and is read only in the browser;
 * the server never sees it in a URL. Headers: `tokenPageHeaders`.
 */
export default function ResetPasswordPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Choose a new password</h1>
      <ResetPasswordForm />
    </>
  );
}
