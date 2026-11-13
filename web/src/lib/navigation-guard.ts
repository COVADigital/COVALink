/**
 * Asks before leaving a page with unsaved changes. A page with a draft
 * registers a confirm function while it's dirty; in-app navigation that
 * doesn't go through a link (the profile switcher, a reload) calls
 * `navigateWithGuard`. Link clicks are caught by the page itself with
 * `guardedLink`. Closing or reloading the tab is covered by `beforeunload`.
 */

/**
 * Shows the confirmation; calls `proceed` only if the person chooses to leave.
 * `origin` gets focus back when the person stays (default: the focused element).
 */
export type ConfirmLeave = (proceed: () => void, origin?: HTMLElement | null) => void;

let current: ConfirmLeave | null = null;

/** Registers the confirmation for the visible page; the returned function removes it. */
export function registerLeaveGuard(confirm: ConfirmLeave): () => void {
  current = confirm;
  return () => {
    if (current === confirm) current = null;
  };
}

/** Runs `proceed` now, or after confirmation when a page has unsaved changes. */
export function navigateWithGuard(proceed: () => void, origin?: HTMLElement | null): void {
  if (current) current(proceed, origin);
  else proceed();
}

export interface ClickInfo {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

export interface LinkInfo {
  href: string;
  target: string;
  download: boolean;
}

/**
 * True only for a plain activation (primary click or Enter) of a link that
 * navigates this window to another page of this site. New-tab, modified and
 * middle clicks, downloads, other origins, same-page fragments and events
 * someone else already handled are left alone.
 */
export function isGuardedNavigation(click: ClickInfo, link: LinkInfo, here: string): boolean {
  if (click.defaultPrevented || click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (link.download || (link.target !== "" && link.target !== "_self")) return false;
  let to: URL;
  let from: URL;
  try {
    to = new URL(link.href, here);
    from = new URL(here);
  } catch {
    return false;
  }
  if (to.origin !== from.origin) return false;
  return !(to.hash !== "" && to.pathname === from.pathname && to.search === from.search);
}

/** The link a click would follow, if leaving through it should be confirmed. */
export function guardedLink(event: MouseEvent): HTMLAnchorElement | null {
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(link instanceof HTMLAnchorElement)) return null;
  const info = { href: link.href, target: link.target, download: link.hasAttribute("download") };
  return isGuardedNavigation(event, info, window.location.href) ? link : null;
}
