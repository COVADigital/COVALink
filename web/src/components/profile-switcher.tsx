"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { selectProfileAction } from "@/features/profiles/actions";
import { navigateWithGuard } from "@/lib/navigation-guard";

export interface SwitcherProfile {
  id: string;
  label: string;
  handle: string;
}

/** Chooses the dashboard's active profile; the server re-checks ownership. */
export function ProfileSwitcher({ profiles, activeId }: { profiles: SwitcherProfile[]; activeId: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function switchTo(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await selectProfileAction(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/dashboard/profiles/${id}`);
      router.refresh();
    });
  }

  // Asked first when the page has unsaved changes; cancelling keeps the current selection and focus.
  const trigger = useRef<HTMLButtonElement>(null);
  const onChange = (id: string) => navigateWithGuard(() => switchTo(id), trigger.current);

  return (
    <div className="flex items-center gap-2">
      <Select value={activeId ?? undefined} onValueChange={onChange} disabled={pending}>
        <SelectTrigger ref={trigger} size="sm" aria-label="Active profile" className="max-w-44" data-testid="profile-switcher">
          <SelectValue placeholder="Choose profile" />
        </SelectTrigger>
        <SelectContent>
          {profiles.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label} <span className="text-muted-foreground">/{p.handle}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
