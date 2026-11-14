"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { FormAlert } from "@/components/auth/form-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteProfileAction } from "@/features/profiles/actions";

/** Profile deletion, confirmed by typing the handle. */
export function DangerZone({ profileId, handle }: { profileId: string; handle: string }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = () => {
    setError(null); // outside the transition so it cannot erase a later error
    startTransition(async () => {
      const result = await deleteProfileAction(profileId);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push("/dashboard/profiles");
      router.refresh();
    });
  };

  return (
    <section aria-labelledby="danger-heading" className="rounded-cl-lg border border-cl-danger/30 bg-cl-surface p-4 ed-md:p-5">
      <h3 id="danger-heading" className="mb-2 text-sm font-semibold">
        Delete profile
      </h3>
      <p className="mb-4 text-sm text-muted-foreground">Deletes this profile and its public page permanently.</p>
      <FormAlert message={error} />
      <AlertDialog onOpenChange={() => setTyped("")}>
        <AlertDialogTrigger asChild>
          <Button variant="destructive">Delete profile</Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete /{handle}?</AlertDialogTitle>
            <AlertDialogDescription>This permanently deletes the profile and takes its page offline.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="confirm-handle">Type {handle} to confirm</Label>
            <Input id="confirm-handle" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={typed !== handle || pending} onClick={remove}>
              {pending ? "Deleting…" : "Delete permanently"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
