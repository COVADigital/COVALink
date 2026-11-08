"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";
import { TOUCH } from "@/components/admin/styles";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { changePasswordFormSchema, PASSWORD_MIN } from "@/features/account/schema";
import { authClient } from "@/lib/auth/client";

type Values = z.infer<typeof changePasswordFormSchema>;
const EMPTY: Values = { currentPassword: "", newPassword: "", confirm: "", signOutOthers: true };

/**
 * Better Auth's `change-password` checks the current password and, with
 * `revokeOtherSessions` (on by default here), signs out every other session
 * and issues this browser a new one, all in one transaction.
 */
export function ChangePasswordForm() {
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(changePasswordFormSchema), defaultValues: EMPTY, shouldFocusError: true });

  useEffect(() => {
    if (saved) statusRef.current?.focus();
  }, [saved]);

  async function onSubmit(values: Values) {
    setFormError(null);
    setSaved(null);
    try {
      const { error } = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: values.signOutOthers,
      });
      if (error) {
        if (error.code === "INVALID_PASSWORD") {
          setError("currentPassword", { message: "That password isn't correct." });
          setFocus("currentPassword");
        } else if (error.code === "PASSWORD_TOO_SHORT" || error.code === "PASSWORD_TOO_LONG") {
          setError("newPassword", { message: "Use 10 to 128 characters." });
          setFocus("newPassword");
        } else {
          setFormError(error.status === 429 ? "Too many attempts. Please wait a few minutes and try again." : "Couldn't change your password. Please try again.");
          setFocus("currentPassword");
        }
        return;
      }
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    reset(EMPTY);
    setSaved(values.signOutOthers ? "Password changed. Your other devices have been signed out." : "Password changed.");
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <FormAlert message={formError} />
      <FormField
        id="currentPassword"
        label="Current password"
        type="password"
        autoComplete="current-password"
        error={errors.currentPassword?.message}
        {...register("currentPassword")}
      />
      <FormField
        id="newPassword"
        label="New password"
        type="password"
        autoComplete="new-password"
        hint={`At least ${PASSWORD_MIN} characters.`}
        error={errors.newPassword?.message}
        {...register("newPassword")}
      />
      <FormField
        id="confirm"
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        error={errors.confirm?.message}
        {...register("confirm")}
      />
      <label htmlFor="signOutOthers" className="flex min-h-11 w-fit items-center gap-3 text-sm">
        <input id="signOutOthers" type="checkbox" className="size-4 accent-primary" {...register("signOutOthers")} />
        Sign out my other devices
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className={TOUCH} disabled={isSubmitting}>
          {isSubmitting ? "Changing…" : "Change password"}
        </Button>
        <p ref={statusRef} tabIndex={-1} role="status" className="text-sm text-muted-foreground outline-none">
          {saved ?? ""}
        </p>
      </div>
    </form>
  );
}
