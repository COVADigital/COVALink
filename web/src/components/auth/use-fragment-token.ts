"use client";

import { useEffect, useState } from "react";
import { tokenFromFragment } from "@/features/account/schema";

/**
 * Reads the `#token=…` fragment once, then removes it from the address bar and
 * the history entry so it can't be bookmarked, shared or shown again.
 * `undefined` while reading, `null` when the link has no usable token.
 */
export function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const found = tokenFromFragment(window.location.hash);
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname);
    // Reading browser-only state after hydration is this effect's purpose.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setToken(found);
  }, []);
  return token;
}
