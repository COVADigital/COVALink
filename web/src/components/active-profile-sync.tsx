"use client";

import { useEffect, useRef } from "react";
import { selectProfileAction } from "@/features/profiles/actions";

/**
 * Makes the profile this page shows the remembered active one. The header
 * already shows it, so this only stores the choice; the server re-checks
 * ownership. `render` is new for every server render, so each fresh visit
 * syncs once, while a page restored with its old render (back/forward, or
 * shown again by <Activity>) doesn't override a newer switcher choice.
 */
export function ActiveProfileSync({ profileId, render }: { profileId: string; render: string }) {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (done.current === render) return;
    done.current = render;
    // Best effort: on failure the cookie keeps the earlier choice, and nothing claims otherwise.
    selectProfileAction(profileId).catch(() => {});
  }, [profileId, render]);
  return null;
}
