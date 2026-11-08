import { DELETE_CONFIRMATION } from "@/features/account/schema";
import { deleteOwnAccount } from "@/features/account/service";
import { auth } from "@/lib/auth/server";
import { TEST_APP_URL } from "./test-env";

/**
 * Calls the real Better Auth HTTP handler (the same one mounted at
 * /api/auth/[...all]), including origin checks and database hooks.
 */
export async function authRequest(
  path: string,
  { method = "POST", body, cookie, origin = TEST_APP_URL }: { method?: string; body?: unknown; cookie?: string; origin?: string | null } = {},
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (origin) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  return auth.handler(
    new Request(`${TEST_APP_URL}/api/auth${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

/** Converts Set-Cookie headers into a Cookie request header value. */
export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

export async function signUp(email: string, extra: Record<string, unknown> = {}) {
  return authRequest("/sign-up/email", { body: { name: email.split("@")[0], email, password: "correct-horse-battery", ...extra } });
}

export async function signIn(email: string, password = "correct-horse-battery") {
  return authRequest("/sign-in/email", { body: { email, password } });
}

/**
 * Deletes the signed-in account the only way COVALink allows: the
 * account service behind the confirmed Server Action (Better Auth's
 * `/delete-user` is blocked over HTTP).
 */
export async function deleteAccount(cookie: string, password = "correct-horse-battery") {
  return deleteOwnAccount(new Headers({ cookie }), { password, confirmation: DELETE_CONFIRMATION });
}
