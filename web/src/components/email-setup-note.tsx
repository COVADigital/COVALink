import { MailWarning } from "lucide-react";
import Link from "next/link";

/**
 * Shown wherever a feature needs email while SMTP isn't configured. The caller
 * decides when (`smtpConfigured()` on the server); this only renders the note,
 * so the editor can show it too. Administrators get a pointer to the fix.
 */
/** Subscribe sign-ups are limited per visitor, so they need `TRUST_PROXY`; shown while it's off. */
export function VisitorAddressNote({ admin = false, className = "" }: { admin?: boolean; className?: string }) {
  return (
    <p role="note" className={`rounded-cl-md bg-cl-inset p-3 text-sm text-cl-ink-2 ${className}`}>
      Subscribe blocks need this server to see each visitor&apos;s own address, so sign-ups can be limited per visitor.
      Until then, visitors don&apos;t see Subscribe blocks.{" "}
      {admin ? (
        <>
          Set <code>TRUST_PROXY=true</code> after the check in the deployment guide.
        </>
      ) : (
        "Ask your administrator to set it up."
      )}
    </p>
  );
}

/** Subscribe sign-ups need the owner's email verified; points to the Account page, which can send the link. */
export function VerifyToCollectNote({ className = "" }: { className?: string }) {
  return (
    <p role="note" className={`rounded-cl-md bg-cl-inset p-3 text-sm text-cl-ink-2 ${className}`}>
      Verify your email address to collect sign-ups. Until then, visitors don&apos;t see Subscribe blocks.{" "}
      <Link href="/dashboard/account" className="font-medium text-cl-ink underline underline-offset-2">
        Verify on the Account page
      </Link>
    </p>
  );
}

export function EmailSetupNote({ admin = false, className = "" }: { admin?: boolean; className?: string }) {
  return (
    <div role="note" className={`flex gap-3 rounded-cl-md border border-cl-warn/40 bg-cl-warn-wash p-4 text-sm text-cl-ink ${className}`}>
      <MailWarning aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-cl-warn" />
      <div className="grid gap-1">
        <p className="font-medium">Email isn&apos;t set up on this server</p>
        <p className="text-cl-ink-2">
          Features that send email won&apos;t work until it&apos;s configured: confirming subscribers, password reset and email
          verification. Your profile pages, links and analytics keep working as normal.{" "}
          {admin ? (
            <>
              Set the <code>SMTP_*</code> environment variables; <Link href="/admin" className="underline underline-offset-2">the Overview</Link>{" "}
              shows when email is configured.
            </>
          ) : (
            "Ask your administrator to set it up."
          )}
        </p>
      </div>
    </div>
  );
}
