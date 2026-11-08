"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { authErrorMessage } from "@/lib/auth/error-messages";
import { safeInternalPath } from "@/lib/validation/url";

const schema = z.object({
  email: z.email("Enter a valid email address"),
  password: z.string().min(1, "Enter your password"),
});
type Values = z.infer<typeof schema>;

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [formError, setFormError] = useState<string | null>(null);
  /** Set when the password was right but the address still needs verifying. */
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema) });

  async function onSubmit(values: Values) {
    setFormError(null);
    const { error } = await authClient.signIn.email({ email: values.email, password: values.password });
    if (error) {
      if (error.status === 403 && error.code === "EMAIL_NOT_VERIFIED") return setUnverifiedEmail(values.email);
      setFormError(authErrorMessage(error, "Couldn't sign in. Please try again."));
      return;
    }
    router.replace(safeInternalPath(params.get("next")));
    router.refresh();
  }

  if (unverifiedEmail) return <VerificationRequired email={unverifiedEmail} onBack={() => setUnverifiedEmail(null)} />;

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      {params.get("account") === "deleted" && (
        <p role="status" className="rounded-lg border bg-muted/50 px-3 py-2 text-sm">
          Your account has been deleted.
        </p>
      )}
      <FormAlert message={formError} />
      <FormField id="email" label="Email" type="email" autoComplete="email" error={errors.email?.message} {...register("email")} />
      <FormField
        id="password"
        label="Password"
        type="password"
        autoComplete="current-password"
        error={errors.password?.message}
        {...register("password")}
      />
      <Button type="submit" size="lg" className="h-11 sm:h-10" disabled={isSubmitting}>
        {isSubmitting ? "Signing in…" : "Sign in"}
      </Button>
      {/* After the button, so the keyboard order stays email → password → sign in. */}
      <Link href="/forgot-password" className="-my-2 inline-flex min-h-11 w-fit items-center justify-self-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        Forgot password?
      </Link>
      <p className="text-center text-sm text-muted-foreground">
        No account?{" "}
        <Link href="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}

/**
 * Shown after a correct password for an unverified address. The
 * resend goes to Better Auth's rate-limited endpoint, whose answer is the
 * same for every address; so is the message here.
 */
function VerificationRequired({ email, onBack }: { email: string; onBack: () => void }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "limited" | "failed">("idle");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => headingRef.current?.focus(), []);
  useEffect(() => {
    if (state === "sent" || state === "limited" || state === "failed") statusRef.current?.focus();
  }, [state]);

  async function resend() {
    setState("sending");
    try {
      const { error } = await authClient.sendVerificationEmail({ email });
      setState(error?.status === 429 ? "limited" : "sent");
    } catch {
      setState("failed");
    }
  }

  const message = {
    sent: "If this address still needs verifying, we've sent a new link. It expires in one hour.",
    limited: "Too many requests. Please wait a few minutes and try again.",
    failed: "Couldn't reach the server. Check your connection and try again.",
  } as const;

  return (
    <div className="grid gap-4 text-sm" data-testid="verification-required">
      <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold outline-none">
        Verify your email to sign in
      </h2>
      <p>Your account needs a verified email address before you can sign in. Open the link we emailed you, or send a new one.</p>
      {state !== "idle" && state !== "sending" && (
        <p
          ref={statusRef}
          tabIndex={-1}
          role={state === "sent" ? "status" : "alert"}
          className={state === "sent" ? "outline-none" : "rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive outline-none"}
        >
          {message[state]}
        </p>
      )}
      <Button type="button" size="lg" className="h-11" disabled={state === "sending"} onClick={resend}>
        {state === "sending" ? "Sending…" : "Send a new verification link"}
      </Button>
      <Button type="button" variant="outline" size="lg" className="h-11" onClick={onBack}>
        Back to sign in
      </Button>
    </div>
  );
}
