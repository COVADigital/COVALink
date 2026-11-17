import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard color-mode cookie is read with parseColorMode and written by a
 * Server Action, which anyone can call over HTTP: it must re-check the session
 * and the allowlist itself. The session and cookie jar are mocked here.
 */
const session = vi.hoisted(() => ({ user: null as null | { id: string } }));
const jar = vi.hoisted(() => ({
  set: vi.fn<(name: string, value: string, options: Record<string, unknown>) => void>(),
  delete: vi.fn<(name: string) => void>(),
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => session.user }));
vi.mock("next/headers", () => ({ cookies: async () => jar }));

import { setColorModeAction } from "@/features/color-mode/actions";
import { COLOR_MODE_COOKIE, COLOR_MODES, parseColorMode } from "@/features/color-mode/mode";

beforeEach(() => {
  session.user = { id: "user-1" };
  jar.set.mockClear();
  jar.delete.mockClear();
  vi.unstubAllEnvs();
});

describe("parseColorMode", () => {
  it("accepts exactly light, dark and system", () => {
    expect(parseColorMode("light")).toBe("light");
    expect(parseColorMode("dark")).toBe("dark");
    expect(parseColorMode("system")).toBe("system");
    expect([...COLOR_MODES].sort()).toEqual(["dark", "light", "system"]);
  });

  it.each([undefined, "", "DARK", "Light", "auto", " dark ", "dark\n", 1, 0, true, {}, ["dark"], null])("follows the system for %j", (value) => {
    expect(parseColorMode(value)).toBe("system");
  });
});

describe("setColorModeAction", () => {
  it("refuses without a session and writes nothing", async () => {
    session.user = null;
    expect(await setColorModeAction("dark")).toEqual({ ok: false, error: "Your session has expired. Please sign in again." });
    expect(jar.set).not.toHaveBeenCalled();
    expect(jar.delete).not.toHaveBeenCalled();
  });

  it.each(["", "DARK", "auto", " dark ", "dark; Path=/x", undefined, null, 1, {}, ["dark"]])("rejects %j and writes nothing", async (value) => {
    const r = await setColorModeAction(value);
    expect(r).toEqual({ ok: false, error: "Choose System, Light or Dark." });
    expect(jar.set).not.toHaveBeenCalled();
    expect(jar.delete).not.toHaveBeenCalled();
  });

  it.each(["light", "dark"] as const)("stores %s as an HttpOnly Lax cookie for a year", async (mode) => {
    expect(await setColorModeAction(mode)).toEqual({ ok: true, data: { mode } });
    expect(jar.delete).not.toHaveBeenCalled();
    expect(jar.set).toHaveBeenCalledOnce();
    expect(jar.set).toHaveBeenCalledWith(COLOR_MODE_COOKIE, mode, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await setColorModeAction("dark");
    expect(jar.set.mock.calls[0][2]).toMatchObject({ secure: true });
  });

  it("deletes the cookie for system instead of storing it", async () => {
    expect(await setColorModeAction("system")).toEqual({ ok: true, data: { mode: "system" } });
    expect(jar.delete).toHaveBeenCalledExactlyOnceWith(COLOR_MODE_COOKIE);
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("dark token blocks in globals.css", () => {
  const css = readFileSync(path.resolve(import.meta.dirname, "../../src/app/globals.css"), "utf8");
  // Declarations of the rule whose selector list ends with `:root[data-color-mode="<mode>"]`.
  const declarations = (mode: string) => {
    const m = new RegExp(`:root\\[data-color-mode="${mode}"\\]\\s*\\{([^}]*)\\}`).exec(css);
    expect(m, `block for ${mode}`).not.toBeNull();
    return m![1].split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean);
  };

  it("keeps the System block (inside prefers-color-scheme: dark) identical to the Dark block", () => {
    const dark = declarations("dark");
    expect(dark.filter((d) => d.startsWith("--cl-"))).toHaveLength(15);
    expect(declarations("system")).toEqual(dark);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*\.cl-scope\[data-color-mode="system"\]/);
  });
});
