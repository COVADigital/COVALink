"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";

/**
 * Lets a signed-in owner verify their address from the Account page (needed to
 * collect Subscribe sign-ups). Same rate-limited endpoint and wording as the
 * sign-in screen's resend.
 */
export function SendVerification({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "limited" | "failed">("idle");

  async function send() {
    setState("sending");
    try {
      const { error } = await authClient.sendVerificationEmail({ email });
      setState(!error ? "sent" : error.status === 429 ? "limited" : "failed");
    } catch {
      setState("failed");
    }
  }

  const message = {
    idle: "",
    sending: "",
    sent: "We've sent a verification link. It expires in one hour.",
    limited: "Too many requests. Please wait a few minutes and try again.",
    failed: "Couldn't send the link. Try again in a moment.",
  }[state];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button type="button" variant="outline" size="sm" className="min-h-11 rounded-full sm:min-h-9" disabled={state === "sending"} onClick={send}>
        {state === "sending" ? "Sending…" : "Send verification link"}
      </Button>
      <p role="status" className="text-sm text-cl-ink-2">
        {message}
      </p>
    </div>
  );
}
