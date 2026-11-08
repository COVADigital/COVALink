import type { ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface FormFieldProps extends ComponentProps<typeof Input> {
  id: string;
  label: string;
  error?: string;
  hint?: string;
}

/** Labelled input with an error message wired up via aria-describedby. */
export function FormField({ id, label, error, hint, ...inputProps }: FormFieldProps) {
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className="h-11 sm:h-10" {...inputProps} />
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function FormAlert({ message }: { message: string | null }) {
  // Always rendered so screen readers announce changes to the live region.
  return (
    <div role="alert" aria-live="assertive" className={message ? "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" : "sr-only"}>
      {message}
    </div>
  );
}
