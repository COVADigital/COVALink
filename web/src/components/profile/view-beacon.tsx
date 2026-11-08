"use client";

import { useEffect, useRef } from "react";
import { BEACON_PATH, SOURCE_PARAM } from "@/features/analytics/paths";

/**
 * Sends one profile-view beacon after the page has rendered and hydrated;
 * it never delays display. A prerendered page waits until it is
 * actually shown. `?src=qr` is reported as the source and then removed from
 * the address bar, so a reload or a shared copy isn't attributed to the QR
 * code again. The beacon carries only the profile id, the source and
 * `document.referrer`; it sets and reads no cookies or storage. Visitors
 * without JavaScript aren't counted.
 */
export function ViewBeacon({ profileId }: { profileId: string }) {
  // A ref, not a local: it survives React's development double-mount, so one page load sends one beacon.
  const sentFor = useRef<string | null>(null);
  useEffect(() => {
    const send = () => {
      if (sentFor.current === profileId) return;
      sentFor.current = profileId;
      const params = new URLSearchParams(window.location.search);
      const source = params.get(SOURCE_PARAM) === "qr" ? "qr" : undefined;
      if (params.has(SOURCE_PARAM)) {
        params.delete(SOURCE_PARAM);
        const query = params.toString();
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
      }
      const referrer = document.referrer ? document.referrer.slice(0, 2048) : undefined;
      fetch(BEACON_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ p: profileId, ...(source && { s: source }), ...(referrer && { r: referrer }) }),
        keepalive: true,
        credentials: "same-origin",
        cache: "no-store",
      }).catch(() => {});
    };
    const doc = document as Document & { prerendering?: boolean };
    if (doc.prerendering) {
      document.addEventListener("prerenderingchange", send, { once: true });
      return () => document.removeEventListener("prerenderingchange", send);
    }
    send();
  }, [profileId]);
  return null;
}
