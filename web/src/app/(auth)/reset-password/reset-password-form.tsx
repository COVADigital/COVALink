"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { useFragmentToken } from "@/components/auth/use-fragment-token";
import { Button } from "@/components/ui/button";
import { PASSWORD_MIN, resetPasswordFormSchema } from "@/features/account/schema";
import { authClient } from "@/lib/auth/client";

type Values = z.infer<typeof resetPasswordFormSchema>;
type Outcome = "done" | "invalid";

/**
 * Sends the fragment token in the POST body of Better Auth's
 * `/api/auth/reset-password`. Better Auth consumes the token, revokes
 * every session and stores the new password in one transaction.
 */
export function ResetPasswordForm() {
  const token = useFragmentToken();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(resetPasswordFormSchema), shouldFocusError: true });

  useEffect(() => {
    if (outcome) resultRef.current?.focus();
  }, [outcome]);

  async function onSubmit(values: Values) {
    if (!token) return;
    setFormError(null);
    try {
      const { error } = await authClient.resetPassword({ newPassword: values.password, token });
      if (!error) return setOutcome("done");
      if (error.status === 429) setFormError("Too many attempts. Please wait a minute and try again.");
      else if (error.code === "INVALID_TOKEN" || error.code === "USER_NOT_FOUND") return setOutcome("invalid");
      else if (error.code === "PASSWORD_TOO_SHORT" || error.code === "PASSWORD_TOO_LONG") setFormError("Choose a password of 10 to 128 characters.");
      else setFormError("Couldn't change your password. Please try again.");
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
    }
    setFocus("password");
  }

  if (token === undefined) {
    return (
      <p className="text-sm text-muted-foreground" aria-busy="true">
        Checking your link…
      </p>
    );
  }

  if (outcome === "done") {
    return (
      <div ref={resultRef} tabIndex={-1} role="status" data-testid="reset-done" className="grid gap-4 text-sm outline-none">
        <p>Your password has been changed and every device has been signed out. Sign in with your new password.</p>
        <Button asChild size="lg" className="h-11">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  if (!token || outcome === "invalid") {
    return (
      <div ref={resultRef} tabIndex={-1} role="alert" data-testid="reset-invalid" className="grid gap-4 text-sm outline-none">
        <p>This link is invalid, has expired or has already been used. Reset links work once, for one hour.</p>
        <Button asChild size="lg" className="h-11">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <p className="text-sm text-muted-foreground">Choosing a new password signs you out on every device.</p>
      <FormAlert message={formError} />
      <FormField
        id="password"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${PASSWORD_MIN} characters.`}
        error={errors.password?.message}
        {...register("password")}
      />
      <FormField
        id="confirm"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        error={errors.confirm?.message}
        {...register("confirm")}
      />
      <Button type="submit" size="lg" className="h-11" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Change password"}
      </Button>
    </form>
  );
}
