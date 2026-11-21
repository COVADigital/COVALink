import { SOURCE_PARAM } from "./paths";

let first: { path: string; source: string | null } | undefined;

/**
 * The `?src=` the visitor landed with on this page, read once per page path before ViewBeacon removes it from the
 * address bar, so the beacon and the business card panel see the same value whichever reads first. Browser only.
 */
export function landingSource(): string | null {
  if (first?.path !== window.location.pathname) {
    first = { path: window.location.pathname, source: new URLSearchParams(window.location.search).get(SOURCE_PARAM) };
  }
  return first.source;
}
