"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { FormAlert } from "@/components/auth/form-field";
import { useFragmentToken } from "@/components/auth/use-fragment-token";
import { Button } from "@/components/ui/button";
import { verifyEmailAction } from "@/features/account/actions";
import type { VerifyOutcome } from "@/features/account/schema";

const RESULTS: Record<VerifyOutcome, { text: string; href: string; action: string; alert?: boolean }> = {
  verified: { text: "Your email address is verified and you're signed in.", href: "/dashboard", action: "Go to your dashboard" },
  "already-verified": { text: "This email address is already verified. You can sign in.", href: "/login", action: "Sign in" },
  expired: {
    text: "This verification link has expired. Links work for one hour; sign in to request a new one.",
    href: "/login",
    action: "Go to sign in",
    alert: true,
  },
  invalid: { text: "This verification link isn't valid. Sign in to request a new one.", href: "/login", action: "Go to sign in", alert: true },
};

/**
 * Verification waits for a click rather than running on load, so a link
 * scanner that renders the page doesn't verify (and sign in) on the owner's
 * behalf.
 */
export function VerifyEmail() {
  const token = useFragmentToken();
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (outcome) resultRef.current?.focus();
  }, [outcome]);

  function verify() {
    if (!token) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await verifyEmailAction({ token });
        if (res.ok) setOutcome(res.data.outcome);
        else setError(res.error);
      } catch {
        setError("Couldn't reach the server. Check your connection and try again.");
      }
    });
  }

  if (token === undefined) {
    return (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Checking your link…
      </p>
    );
  }

  const result = outcome ?? (token === null ? "invalid" : null);
  if (result) {
    const r = RESULTS[result];
    return (
      <div ref={resultRef} tabIndex={-1} role={r.alert ? "alert" : "status"} data-testid={`verify-${result}`} className="grid gap-4 text-sm outline-none">
        <p>{r.text}</p>
        <Button asChild size="lg" className="h-11">
          <Link href={r.href}>{r.action}</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 text-sm">
      <p className="text-muted-foreground">Confirm that this is your email address to finish setting up your account.</p>
      <FormAlert message={error} />
      <Button type="button" size="lg" className="h-11" disabled={pending} onClick={verify}>
        {pending ? "Verifying…" : "Verify my email"}
      </Button>
    </div>
  );
}
