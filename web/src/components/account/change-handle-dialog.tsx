"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { TOUCH } from "@/components/admin/styles";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { updateProfileMetaAction } from "@/features/profiles/actions";
import { handleSchema } from "@/features/profiles/handle";

/**
 * Changes a profile's handle in two steps: enter it, then review that the old
 * address stops working. The Server Action checks ownership, the format,
 * reserved and taken handles; the check here only gives quick feedback.
 * Mounted only while open, so every opening starts from the current handle.
 */
export function ChangeHandleDialog({
  open,
  onOpenChange,
  onChanged,
  profileId,
  label,
  handle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: (handle: string) => void;
  profileId: string;
  label: string;
  handle: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState(handle);
  const [review, setReview] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fieldRef = useRef<HTMLInputElement>(null);

  // After the server refuses the handle, the dialog steps back: put focus on the field so its error is read.
  useEffect(() => {
    if (review === null && (error || formError)) fieldRef.current?.focus();
  }, [review, error, formError]);

  function change(next: boolean) {
    if (!pending) onOpenChange(next);
  }

  function toReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = handleSchema.safeParse(value);
    // Focus directly: the same message twice doesn't re-render, so the effect below wouldn't run again.
    const refuse = (message?: string) => (setError(message), fieldRef.current?.focus());
    if (!parsed.success) return refuse(parsed.error.issues[0]?.message);
    if (parsed.data === handle) return refuse("That's already this profile's handle.");
    setError(undefined);
    setReview(parsed.data);
  }

  function confirm() {
    if (!review) return;
    setFormError(null);
    startTransition(async () => {
      try {
        const result = await updateProfileMetaAction(profileId, { handle: review });
        if (!result.ok) {
          setError(result.fieldErrors?.handle?.[0]);
          setFormError(result.fieldErrors?.handle ? null : result.error);
          setReview(null);
          return;
        }
        onChanged(result.data.handle);
        onOpenChange(false);
        router.refresh();
      } catch {
        setFormError("Couldn't reach the server. Check your connection and try again.");
        setReview(null);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md">
        {review === null ? (
          <form onSubmit={toReview} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Change handle</DialogTitle>
              <DialogDescription>The handle is the address of {label}&apos;s public page.</DialogDescription>
            </DialogHeader>
            <FormAlert message={formError} />
            <FormField
              ref={fieldRef}
              id={`handle-${profileId}`}
              label="New handle"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="none"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              error={error}
              hint="Changing your handle also changes your page address."
            />
            <DialogFooter>
              <Button type="button" variant="outline" className={`rounded-full ${TOUCH}`} onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" className={`rounded-full ${TOUCH}`} disabled={!value.trim()}>
                Review handle change
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Change /{handle} to /{review}?</DialogTitle>
              <DialogDescription>
                /{handle} stops working at once and the page moves to /{review}. Links and QR codes you shared before will break.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" className={`rounded-full ${TOUCH}`} disabled={pending} onClick={() => setReview(null)}>
                Back
              </Button>
              <Button type="button" className={`rounded-full ${TOUCH}`} disabled={pending} onClick={confirm}>
                {pending ? "Changing…" : "Change handle"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
