"use server";

import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/errors";
import { COLOR_MODES, COLOR_MODE_COOKIE, type ColorMode } from "./mode";

/** A Server Action is a public endpoint: it re-checks the session and the allowlist. */
export async function setColorModeAction(mode: unknown): Promise<ActionResult<{ mode: ColorMode }>> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Your session has expired. Please sign in again." };
  if (typeof mode !== "string" || !(COLOR_MODES as readonly string[]).includes(mode)) {
    return { ok: false, error: "Choose System, Light or Dark." };
  }
  const jar = await cookies();
  if (mode === "system") jar.delete(COLOR_MODE_COOKIE);
  else {
    jar.set(COLOR_MODE_COOKIE, mode, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return { ok: true, data: { mode: mode as ColorMode } };
}
