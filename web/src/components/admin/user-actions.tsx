"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DESTRUCTIVE_OUTLINE, TOUCH } from "@/components/admin/styles";
import { Button } from "@/components/ui/button";
import { changeUserRoleAction, setUserDisabledAction } from "@/features/admin/actions";
import { ROLE_LABELS } from "@/features/admin/audit-format";
import type { Role } from "@/lib/auth/permissions";

type Pending = { kind: "disable" } | { kind: "enable" } | { kind: "role"; role: Role };

/**
 * Disable / re-enable and role changes for one account. Each change
 * is confirmed in a dialog; controls are disabled while it runs; the result
 * is announced in a live region, which also receives focus (the button that
 * opened the dialog may no longer exist once the page refreshes). The server
 * re-checks everything; `allowed` only decides which controls to offer.
 */
export function UserActions({
  user,
  allowed,
}: {
  user: { id: string; name: string; role: Role; disabled: boolean };
  allowed: { disable: boolean; enable: boolean; roles: Role[] };
}) {
  const router = useRouter();
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const statusRef = useRef<HTMLParagraphElement>(null);
  // The dialog is opened from state (no Radix trigger), so focus is restored by hand:
  // to the button that opened it on cancel, to the announced result after a change.
  const openerRef = useRef<HTMLElement | null>(null);
  const completedRef = useRef(false);
  const open = (p: Pending, opener: HTMLElement) => {
    openerRef.current = opener;
    completedRef.current = false;
    setConfirm(p);
  };

  const run = (p: Pending) => {
    setMessage(null);
    startTransition(async () => {
      const result =
        p.kind === "role"
          ? await changeUserRoleAction({ userId: user.id, role: p.role })
          : await setUserDisabledAction({ userId: user.id, disabled: p.kind === "disable" });
      completedRef.current = true;
      setConfirm(null);
      if (!result.ok) setMessage({ tone: "error", text: result.error });
      else if (!result.data.changed) setMessage({ tone: "ok", text: "Nothing changed: the account was already in that state." });
      else
        setMessage({
          tone: "ok",
          text:
            p.kind === "role"
              ? `${user.name} is now ${ROLE_LABELS[p.role].toLowerCase()}.`
              : p.kind === "disable"
                ? `${user.name}'s account is disabled and signed out everywhere.`
                : `${user.name}'s account is enabled again. They need to sign in again.`,
        });
      router.refresh();
      requestAnimationFrame(() => statusRef.current?.focus());
    });
  };

  const none = !allowed.disable && !allowed.enable && allowed.roles.length === 0;
  const title =
    confirm?.kind === "disable"
      ? `Disable ${user.name}'s account?`
      : confirm?.kind === "enable"
        ? `Re-enable ${user.name}'s account?`
        : confirm?.kind === "role"
          ? `Make ${user.name} ${ROLE_LABELS[confirm.role].toLowerCase()}?`
          : "";
  const description =
    confirm?.kind === "disable"
      ? "They are signed out everywhere, can't sign in, and their public profiles go offline immediately. You can re-enable the account later."
      : confirm?.kind === "enable"
        ? "They can sign in again (they must sign in anew) and their published profiles come back online."
        : confirm?.kind === "role" && confirm.role === "admin"
          ? "Administrators can manage users, settings and see the audit log."
          : "They lose administrator access immediately.";

  return (
    <section aria-labelledby="actions-heading" className="grid gap-3 rounded-xl border bg-card p-5">
      <h2 id="actions-heading" className="text-sm font-medium">
        Actions
      </h2>
      {none ? (
        <p className="text-sm text-muted-foreground" data-testid="no-actions">
          You can&apos;t change this account. Administrators can&apos;t change their own account, other administrators or the super administrator.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {allowed.disable && (
            <Button variant="outline" className={`min-h-11 sm:min-h-8 ${DESTRUCTIVE_OUTLINE}`} disabled={pending} onClick={(e) => open({ kind: "disable" }, e.currentTarget)}>
              Disable account
            </Button>
          )}
          {allowed.enable && (
            <Button className="min-h-11 sm:min-h-8" disabled={pending} onClick={(e) => open({ kind: "enable" }, e.currentTarget)}>
              Re-enable account
            </Button>
          )}
          {allowed.roles.map((role) => (
            <Button key={role} variant="outline" className="min-h-11 sm:min-h-8" disabled={pending} onClick={(e) => open({ kind: "role", role }, e.currentTarget)}>
              {role === "admin" ? "Make administrator" : "Remove administrator role"}
            </Button>
          ))}
        </div>
      )}
      <p
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        data-testid="action-status"
        className={message ? (message.tone === "error" ? "text-sm text-destructive outline-none" : "text-sm outline-none") : "sr-only"}
      >
        {message?.text}
      </p>
      <AlertDialog open={confirm !== null} onOpenChange={(isOpen) => !isOpen && !pending && setConfirm(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            (completedRef.current ? statusRef.current : openerRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={TOUCH} disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant={confirm?.kind === "disable" ? "outline" : "default"}
              className={confirm?.kind === "disable" ? `${TOUCH} ${DESTRUCTIVE_OUTLINE}` : TOUCH}
              disabled={pending}
              onClick={() => confirm && run(confirm)}
            >
              {pending ? "Saving…" : confirm?.kind === "disable" ? "Disable" : confirm?.kind === "enable" ? "Re-enable" : "Change role"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
