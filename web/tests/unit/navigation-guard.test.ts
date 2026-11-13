import { describe, expect, it, vi } from "vitest";
import { isGuardedNavigation, navigateWithGuard, registerLeaveGuard } from "@/lib/navigation-guard";

const HERE = "https://links.example.com/dashboard/profiles/abc";
const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
const link = { href: "/dashboard/profiles", target: "", download: false };

describe("isGuardedNavigation", () => {
  it("guards a plain activation of a same-origin link", () => {
    expect(isGuardedNavigation(click, link, HERE)).toBe(true);
    expect(isGuardedNavigation(click, { ...link, href: "https://links.example.com/dashboard" }, HERE)).toBe(true);
    expect(isGuardedNavigation(click, { ...link, target: "_self" }, HERE)).toBe(true);
    expect(isGuardedNavigation(click, { ...link, href: "/dashboard/profiles/abc?tab=x" }, HERE)).toBe(true);
    expect(isGuardedNavigation(click, { ...link, href: "/dashboard#top" }, HERE)).toBe(true);
  });

  it.each([
    ["another origin", { href: "https://example.org/" }],
    ["another port", { href: "https://links.example.com:8443/dashboard" }],
    ["http on an https site", { href: "http://links.example.com/dashboard" }],
    ["a mailto link", { href: "mailto:a@example.com" }],
    ["a same-page fragment", { href: "#blocks" }],
    ["a fragment of this page by path", { href: "/dashboard/profiles/abc#blocks" }],
    ["a new tab", { target: "_blank" }],
    ["a named window", { target: "preview" }],
    ["a download", { download: true }],
  ])("ignores %s", (_, change) => {
    expect(isGuardedNavigation(click, { ...link, ...change }, HERE)).toBe(false);
  });

  it.each([
    ["the middle button", { button: 1 }],
    ["the secondary button", { button: 2 }],
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["an event already handled", { defaultPrevented: true }],
  ])("ignores a click with %s", (_, change) => {
    expect(isGuardedNavigation({ ...click, ...change }, link, HERE)).toBe(false);
  });

  it("ignores an unparseable address", () => {
    expect(isGuardedNavigation(click, { ...link, href: "http://[" }, HERE)).toBe(false);
  });
});

describe("navigateWithGuard", () => {
  it("navigates at once when no page has unsaved changes", () => {
    const proceed = vi.fn();
    navigateWithGuard(proceed);
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("hands the navigation to the registered confirmation until it is removed", () => {
    let held: (() => void) | null = null;
    const unregister = registerLeaveGuard((p) => {
      held = p;
    });
    const proceed = vi.fn();
    navigateWithGuard(proceed);
    expect(proceed).not.toHaveBeenCalled();
    held!();
    expect(proceed).toHaveBeenCalledOnce();

    unregister();
    navigateWithGuard(proceed);
    expect(proceed).toHaveBeenCalledTimes(2);
  });

  it("removing an older registration keeps the newer one", () => {
    const older = registerLeaveGuard(() => {});
    const newer = vi.fn();
    const unregisterNewer = registerLeaveGuard(newer);
    older();
    navigateWithGuard(() => {});
    expect(newer).toHaveBeenCalledOnce();
    unregisterNewer();
  });
});
