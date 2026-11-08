"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { TOUCH } from "@/components/admin/styles";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { ACCOUNT_NAME_MAX, ACCOUNT_NAME_MESSAGE, accountNameSchema } from "@/features/account/schema";
import { authClient } from "@/lib/auth/client";

const schema = z.object({ name: accountNameSchema });
type Values = z.infer<typeof schema>;

/**
 * The account name, saved through Better Auth's `update-user`; the
 * database hook applies the same rule to every update.
 */
export function AccountNameForm({ name }: { name: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const {
    register,
    handleSubmit,
    setError,
    setFocus,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name }, shouldFocusError: true });

  useEffect(() => {
    if (saved) statusRef.current?.focus();
  }, [saved]);

  async function onSubmit(values: Values) {
    setFormError(null);
    setSaved(false);
    try {
      const { error } = await authClient.updateUser({ name: values.name.trim() });
      if (error) {
        if (error.status === 400) setError("name", { message: ACCOUNT_NAME_MESSAGE });
        else setFormError(error.status === 429 ? "Too many attempts. Please wait a minute and try again." : "Couldn't save your account name. Please try again.");
        setFocus("name");
        return;
      }
    } catch {
      setFormError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    reset({ name: values.name.trim() });
    setSaved(true);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4">
      <FormAlert message={formError} />
      <FormField
        id="name"
        label="Account name"
        autoComplete="name"
        maxLength={ACCOUNT_NAME_MAX + 20}
        hint="Your name on this account. Each profile has its own display name."
        error={errors.name?.message}
        {...register("name")}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className={TOUCH} disabled={isSubmitting || !isDirty}>
          {isSubmitting ? "Saving…" : "Save account name"}
        </Button>
        <p ref={statusRef} tabIndex={-1} role="status" className="text-sm text-muted-foreground outline-none">
          {saved ? "Account name saved." : ""}
        </p>
      </div>
    </form>
  );
}
