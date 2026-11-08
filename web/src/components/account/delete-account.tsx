"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { DESTRUCTIVE_OUTLINE, TOUCH } from "@/components/admin/styles";
import { FormAlert, FormField } from "@/components/auth/form-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { deleteAccountAction } from "@/features/account/actions";
import { DELETE_CONFIRMATION } from "@/features/account/schema";

/**
 * Self-deletion. The password and the typed phrase are checked by the
 * Server Action on the server; the checks here only give quick feedback.
 * Administrators see why they can't delete their account instead of a button
 * that would fail.
 */
export function DeleteAccount({ blockedReason }: { blockedReason: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<{ form?: string; password?: string; confirmation?: string }>({});
  const openerRef = useRef<HTMLButtonElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmationRef = useRef<HTMLInputElement>(null);
  /** Field to focus once the form is enabled again (inputs are disabled while the action runs). */
  const [focusRequest, setFocusRequest] = useState<{ field: "password" | "confirmation" } | null>(null);

  useEffect(() => {
    if (!pending && focusRequest) (focusRequest.field === "password" ? passwordRef : confirmationRef).current?.focus();
  }, [pending, focusRequest]);

  if (blockedReason) {
    return (
      <div className="grid gap-3">
        <p id="delete-blocked" className="text-sm text-muted-foreground">
          {blockedReason}
        </p>
        <Button type="button" variant="outline" className={`w-fit ${TOUCH}`} disabled aria-describedby="delete-blocked">
          Delete account
        </Button>
      </div>
    );
  }

  function close(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setErrors({});
      // Opened from state, not a Radix trigger, so focus goes back by hand.
      requestAnimationFrame(() => openerRef.current?.focus());
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password") ?? "");
    const confirmation = String(data.get("confirmation") ?? "");
    const local = {
      password: password ? undefined : "Enter your password",
      confirmation: confirmation === DELETE_CONFIRMATION ? undefined : `Type "${DELETE_CONFIRMATION}" exactly.`,
    };
    if (local.password || local.confirmation) {
      setErrors(local);
      setFocusRequest({ field: local.password ? "password" : "confirmation" });
      return;
    }
    setErrors({});
    startTransition(async () => {
      try {
        const res = await deleteAccountAction({ password, confirmation });
        if (res.ok) {
          // The session cookie is gone; refresh drops the signed-in router cache.
          router.replace("/login?account=deleted");
          router.refresh();
          return;
        }
        const next = { form: res.fieldErrors ? undefined : res.error, password: res.fieldErrors?.password?.[0], confirmation: res.fieldErrors?.confirmation?.[0] };
        setErrors(next);
        setFocusRequest({ field: next.confirmation ? "confirmation" : "password" });
      } catch {
        setErrors({ form: "Couldn't reach the server. Check your connection and try again." });
        setFocusRequest({ field: "password" });
      }
    });
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-muted-foreground">
        Deleting your account permanently removes your profiles, their content, analytics and uploaded images. This can&apos;t be undone.
      </p>
      <Button ref={openerRef} type="button" variant="outline" className={`w-fit ${TOUCH} ${DESTRUCTIVE_OUTLINE}`} onClick={() => setOpen(true)}>
        Delete account…
      </Button>
      <AlertDialog open={open} onOpenChange={close}>
        <AlertDialogContent>
          <form onSubmit={submit} noValidate className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete your account?</AlertDialogTitle>
              <AlertDialogDescription>
                Your profiles go offline at once and everything you created is deleted. Enter your password and type{" "}
                <strong className="font-semibold text-foreground">{DELETE_CONFIRMATION}</strong> to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <FormAlert message={errors.form ?? null} />
            <FormField ref={passwordRef} id="delete-password" name="password" label="Password" type="password" autoComplete="current-password" error={errors.password} disabled={pending} />
            <FormField
              ref={confirmationRef}
              id="delete-confirmation"
              name="confirmation"
              label={`Type "${DELETE_CONFIRMATION}"`}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              error={errors.confirmation}
              disabled={pending}
            />
            <AlertDialogFooter>
              <AlertDialogCancel className={TOUCH} disabled={pending}>
                Cancel
              </AlertDialogCancel>
              <Button type="submit" variant="outline" className={`${TOUCH} ${DESTRUCTIVE_OUTLINE}`} disabled={pending}>
                {pending ? "Deleting…" : "Delete my account"}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
