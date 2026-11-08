import type { Metadata } from "next";
import { VerifyEmail } from "./verify-email";

export const metadata: Metadata = { title: "Verify your email", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * The token arrives in the link fragment and is read only in the browser;
 * it reaches the server in a Server Action body after a click.
 * Headers: `tokenPageHeaders`.
 */
export default function VerifyEmailPage() {
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold tracking-tight">Verify your email</h1>
      <VerifyEmail />
    </>
  );
}
