"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { emailRequestSchema } from "@/features/account/schema";
import { authClient } from "@/lib/auth/client";

type Values = z.infer<typeof emailRequestSchema>;

/**
 * Posts to Better Auth's rate-limited reset request. The answer is the same
 * for every address, so the page shows one message whatever happened,
 * except for rate limiting and network failures.
 */
export function ForgotPasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(emailRequestSchema), shouldFocusError: true });

  useEffect(() => {
    if (sent) statusRef.current?.focus();
  }, [sent]);

  async function onSubmit(values: Values) {
    setFormError(null);
    try {
      const { error } = await authClient.requestPasswordReset({ email: values.email });
      if (error?.status === 429) {
        setFormError("Too many requests. Please wait a few minutes and try again.");
        setFocus("email");
        return;
      }
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="grid gap-4 text-sm">
        <p ref={statusRef} tabIndex={-1} role="status" data-testid="reset-requested" className="outline-none">
          If an account uses that address, we&apos;ve sent it a link to choose a new password. The link expires in one hour.
        </p>
        <Link href="/login" className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <p className="text-sm text-muted-foreground">Enter your account&apos;s email address and we&apos;ll send you a link to choose a new password.</p>
      <FormAlert message={formError} />
      <FormField id="email" label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
      <Button type="submit" size="lg" className="h-11" disabled={isSubmitting}>
        {isSubmitting ? "Sending…" : "Send reset link"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="inline-flex min-h-11 items-center font-medium text-foreground underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
