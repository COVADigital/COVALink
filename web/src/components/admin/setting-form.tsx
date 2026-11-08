"use client";

import { TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { DESTRUCTIVE_OUTLINE, TOUCH } from "@/components/admin/styles";
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
import { Switch } from "@/components/ui/switch";
import { updateSettingAction } from "@/features/admin/actions";
import type { SettingSpec } from "@/features/settings/catalog";

type Value = boolean | number | string;

/** Client-side check against the catalog bounds (the server validates again with the real schema). */
function validate(spec: SettingSpec, raw: Value): { value?: Value; error?: string } {
  if (spec.kind === "boolean") return { value: Boolean(raw) };
  if (spec.kind === "integer") {
    const text = String(raw).trim();
    if (!/^\d+$/.test(text)) return { error: "Enter a whole number." };
    const n = Number(text);
    if (n < (spec.min ?? 0) || n > (spec.max ?? Number.MAX_SAFE_INTEGER)) return { error: `Enter a number from ${spec.min} to ${spec.max}.` };
    return { value: n };
  }
  const text = String(raw).trim();
  if (!text) return { error: "This can't be empty." };
  if (text.length > (spec.maxLength ?? 200)) return { error: `Use at most ${spec.maxLength} characters.` };
  return { value: text };
}

/**
 * One installation setting. Inline validation, a locked form while
 * saving, an announced result that also receives focus, and, for turning
 * invite-only on, a confirmation that registration will close completely.
 * Read-only for administrators when it is a security setting.
 */
export function SettingForm({ spec, value, editable }: { spec: SettingSpec; value: Value; editable: boolean }) {
  const router = useRouter();
  const id = useId();
  const [draft, setDraft] = useState<Value>(spec.kind === "integer" ? String(value) : value);
  const [saved, setSaved] = useState<Value>(value);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirming, setConfirming] = useState<Value | null>(null);
  const [pending, startTransition] = useTransition();
  const statusRef = useRef<HTMLParagraphElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The confirmation opens from Save (no Radix trigger): focus returns there on cancel, to the result after saving.
  const saveRef = useRef<HTMLButtonElement>(null);
  const completedRef = useRef(false);

  const dirty = spec.kind === "integer" ? String(draft).trim() !== String(saved) : draft !== saved;

  const save = (next: Value) => {
    setMessage(null);
    startTransition(async () => {
      const result = await updateSettingAction({ key: spec.key, value: next });
      completedRef.current = true;
      setConfirming(null);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        requestAnimationFrame(() => statusRef.current?.focus());
        return;
      }
      setSaved(next);
      setDraft(spec.kind === "integer" ? String(next) : next);
      setMessage({ tone: "ok", text: result.data.changed ? `${spec.label} saved.` : "Nothing changed." });
      router.refresh();
      requestAnimationFrame(() => statusRef.current?.focus());
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = validate(spec, draft);
    if (checked.error) {
      setError(checked.error);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    if (spec.key === "registration.inviteOnly" && checked.value === true && saved !== true) {
      completedRef.current = false;
      setConfirming(true);
    } else save(checked.value!);
  };

  const inputId = `${id}-input`;
  const descId = `${id}-desc`;
  const errId = `${id}-err`;

  return (
    <form onSubmit={submit} noValidate className="grid gap-3 py-4 first:pt-0 last:pb-0" data-testid={`setting-${spec.key}`} aria-labelledby={`${id}-label`}>
      <div className="grid gap-1">
        <span id={`${id}-label`} className="text-sm font-medium">
          {spec.label}
          {spec.security && <span className="ml-2 text-xs font-normal text-muted-foreground">(super administrator only)</span>}
        </span>
        {spec.key === "registration.inviteOnly" ? (
          // A warning in the text itself, not a nested box: the consequence is the point.
          <p id={descId} className="flex gap-2 text-sm font-medium text-pretty">
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>{spec.description}</span>
          </p>
        ) : (
          <p id={descId} className="text-sm text-pretty text-muted-foreground">
            {spec.description}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {spec.kind === "boolean" ? (
          <label htmlFor={inputId} className="inline-flex min-h-11 items-center gap-3 text-sm sm:min-h-9">
            <Switch
              id={inputId}
              // The switch's own hit area grows to 46 px tall (its ::after), beyond the 44 px label row.
              className="after:-inset-y-3.5"
              checked={Boolean(draft)}
              disabled={!editable || pending}
              onCheckedChange={(c) => setDraft(c)}
              aria-describedby={descId}
            />
            {draft ? "On" : "Off"}
          </label>
        ) : (
          <div className="grid gap-1">
            <label htmlFor={inputId} className="sr-only">
              {spec.label}
              {spec.unit ? ` (${spec.unit})` : ""}
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                id={inputId}
                type="text"
                inputMode={spec.kind === "integer" ? "numeric" : undefined}
                value={String(draft)}
                disabled={!editable || pending}
                maxLength={spec.kind === "text" ? spec.maxLength : 6}
                onChange={(e) => setDraft(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={[descId, error ? errId : null].filter(Boolean).join(" ")}
                className="h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm disabled:opacity-60 sm:h-9 sm:w-64"
              />
              {spec.unit && <span className="text-sm text-muted-foreground">{spec.unit}</span>}
            </div>
          </div>
        )}
        {editable && (
          <Button ref={saveRef} type="submit" variant="outline" className="min-h-11 sm:min-h-8" disabled={pending || !dirty}>
            {pending ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {error && (
        <p id={errId} className="text-sm text-destructive">
          {error}
        </p>
      )}
      <p
        ref={statusRef}
        tabIndex={-1}
        role="status"
        aria-live="polite"
        className={message ? (message.tone === "error" ? "text-sm text-destructive outline-none" : "text-sm outline-none") : "sr-only"}
      >
        {message?.text}
      </p>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !pending && setConfirming(null)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            (completedRef.current ? statusRef.current : saveRef.current)?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Close registration completely?</AlertDialogTitle>
            <AlertDialogDescription>
              Invitations aren&apos;t available yet. With invite-only on, nobody can create an account, even with public sign-up on. Existing
              accounts are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={TOUCH} disabled={pending}>
              Cancel
            </AlertDialogCancel>
            <Button variant="outline" className={`${TOUCH} ${DESTRUCTIVE_OUTLINE}`} disabled={pending} onClick={() => save(true)}>
              {pending ? "Saving…" : "Turn on invite-only"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
