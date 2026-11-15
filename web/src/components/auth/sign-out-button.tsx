"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { navigateWithGuard } from "@/lib/navigation-guard";
import { authClient } from "@/lib/auth/client";

/** Signs out and returns to the login page; shared by the header button and the editor's workspace menu. */
export function useSignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    const { error } = await authClient.signOut();
    if (error) {
      setFailed(true);
      setPending(false);
      return;
    }
    router.replace("/login");
    router.refresh();
  }

  return { signOut: () => navigateWithGuard(() => { void signOut(); }), pending, failed };
}

export function SignOutButton() {
  const { signOut, pending, failed } = useSignOut();
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" onClick={signOut} disabled={pending}>
        {pending ? "Signing out…" : "Sign out"}
      </Button>
      {failed && (
        <span role="alert" className="text-xs text-destructive">
          Sign-out failed. Try again.
        </span>
      )}
    </div>
  );
}
