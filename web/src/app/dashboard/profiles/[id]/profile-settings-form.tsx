"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormAlert, FormField } from "@/components/auth/form-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { updateProfileMetaAction } from "@/features/profiles/actions";
import { normalizeHandle } from "@/features/profiles/handle";

const schema = z.object({
  handle: z.string().trim().min(2, "Handles need at least 2 characters").max(40),
  label: z.string().trim().min(1, "Give this profile a name").max(40),
});
type Values = z.infer<typeof schema>;

/** Handle and internal name. Changing the handle is confirmed because the old link stops working. */
export function ProfileSettingsForm({ profileId, handle, label }: { profileId: string; handle: string; label: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Values | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { handle, label } });

  async function submit(values: Values) {
    setFormError(null);
    setSaved(null);
    const result = await updateProfileMetaAction(profileId, values);
    if (!result.ok) {
      setFormError(result.error);
      for (const [field, messages] of Object.entries(result.fieldErrors ?? {})) {
        if (messages?.[0]) setError(field as keyof Values, { message: messages[0] });
      }
      return;
    }
    reset({ handle: result.data.handle, label: values.label });
    setSaved(`Saved. Your page address is /${result.data.handle}.`);
    router.refresh();
  }

  const onSubmit = handleSubmit((values) => {
    if (normalizeHandle(values.handle) !== handle) setConfirming(values);
    else void submit(values);
  });

  return (
    <section aria-labelledby="settings-heading" className="rounded-xl border bg-card p-5">
      <h2 id="settings-heading" className="mb-4 text-sm font-medium">
        Address &amp; name
      </h2>
      <form onSubmit={onSubmit} noValidate className="grid gap-4 sm:max-w-md">
        <FormAlert message={formError} />
        <FormField id="settings-handle" label="Handle" spellCheck={false} autoComplete="off" error={errors.handle?.message} {...register("handle")} />
        <FormField id="settings-label" label="Profile name (only you see this)" error={errors.label?.message} {...register("label")} />
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {saved}
        </p>
        <Button type="submit" variant="outline" className="w-fit" disabled={isSubmitting || !isDirty}>
          Save address &amp; name
        </Button>
      </form>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change your page address?</AlertDialogTitle>
            <AlertDialogDescription>
              /{handle} will stop working immediately and your page moves to /{normalizeHandle(confirming?.handle ?? "")}. Links you
              shared before will break.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) void submit(confirming);
                setConfirming(null);
              }}
            >
              Change address
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
