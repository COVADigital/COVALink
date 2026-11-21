"use client";

import { useEffect, useRef, useState } from "react";
import { FormAlert } from "@/components/auth/form-field";
import { useFragmentToken } from "@/components/auth/use-fragment-token";
import { Button } from "@/components/ui/button";
import { SUBSCRIBE_CONFIRM_PATH, SUBSCRIBE_REMOVE_PATH } from "@/features/audience/consent";

const COPY = {
  confirm: {
    intro: "Confirm that you want to join this list. The profile owner will see your email address.",
    button: "Confirm subscription",
    busy: "Confirming…",
    done: "You're subscribed. To leave the list later, use the remove link in the confirmation email.",
    gone: "This link has expired or was already used. Sign up again on the profile page if you still want to join.",
  },
  remove: {
    intro: "Remove your email address from this list. The profile owner won't see it any more.",
    button: "Remove my email",
    busy: "Removing…",
    done: "Your email address was removed from this list.",
    gone: "This link was already used, or the address was removed. Nothing more to do.",
  },
} as const;

/**
 * Confirms or removes a sign-up with the token from the emailed link. It waits
 * for a click, so a mail scanner that opens the link changes nothing.
 */
export function SubscribeToken({ action }: { action: "confirm" | "remove" }) {
  const token = useFragmentToken();
  const copy = COPY[action];
  const [result, setResult] = useState<"done" | "gone" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resultRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  async function submit() {
    if (!token) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch(action === "confirm" ? SUBSCRIBE_CONFIRM_PATH : SUBSCRIBE_REMOVE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
        credentials: "same-origin",
        cache: "no-store",
      });
      if (res.status === 200) setResult("done");
      else if (res.status === 410 || res.status === 400) setResult("gone");
      else setError("Something went wrong. Try again in a moment.");
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  if (token === undefined) {
    return (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Checking your link…
      </p>
    );
  }
  const shown = result ?? (token === null ? "gone" : null);
  if (shown) {
    return (
      <p ref={resultRef} tabIndex={-1} role={shown === "gone" ? "alert" : "status"} data-testid={`subscribe-${shown}`} className="text-sm outline-none">
        {copy[shown]}
      </p>
    );
  }
  return (
    <div className="grid gap-4 text-sm">
      <p className="text-muted-foreground">{copy.intro}</p>
      <FormAlert message={error} />
      <Button type="button" size="lg" className="h-11" disabled={pending} onClick={submit}>
        {pending ? copy.busy : copy.button}
      </Button>
    </div>
  );
}
