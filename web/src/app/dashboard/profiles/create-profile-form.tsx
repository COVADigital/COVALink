"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import { Button } from "@/components/ui/button";
import { createProfileAction } from "@/features/profiles/actions";
import { normalizeHandle } from "@/features/profiles/handle";

const schema = z.object({
  handle: z.string().trim().min(2, "Handles need at least 2 characters").max(40),
  label: z.string().trim().min(1, "Give this profile a name").max(40),
  displayName: z.string().trim().min(1, "Add a display name").max(60),
});
type Values = z.infer<typeof schema>;

export function CreateProfileForm({ disabledReason }: { disabledReason?: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors, isSubmitting },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { handle: "", label: "", displayName: "" } });
  const handle = useWatch({ control, name: "handle" });
  const normalized = normalizeHandle(handle ?? "");

  async function onSubmit(values: Values) {
    setFormError(null);
    const result = await createProfileAction(values);
    if (!result.ok) {
      setFormError(result.error);
      for (const [field, messages] of Object.entries(result.fieldErrors ?? {})) {
        if (messages?.[0]) setError(field as keyof Values, { message: messages[0] });
      }
      return;
    }
    router.push(`/dashboard/profiles/${result.data.id}`);
    router.refresh();
  }

  if (disabledReason) return <p className="text-sm text-muted-foreground">{disabledReason}</p>;

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="grid gap-4 sm:max-w-md">
      <FormAlert message={formError} />
      <FormField
        id="handle"
        label="Handle"
        autoComplete="off"
        spellCheck={false}
        hint={normalized ? `Your page will be at /${normalized}` : "Letters, numbers, hyphens and underscores."}
        error={errors.handle?.message}
        {...register("handle")}
      />
      <FormField
        id="label"
        label="Profile name (only you see this)"
        placeholder="Personal"
        error={errors.label?.message}
        {...register("label")}
      />
      <FormField id="displayName" label="Display name" autoComplete="name" error={errors.displayName?.message} {...register("displayName")} />
      <Button type="submit" className="h-9 w-fit" disabled={isSubmitting}>
        {isSubmitting ? "Creating…" : "Create profile"}
      </Button>
    </form>
  );
}
