/**
 * Better Auth endpoints that are never reachable over HTTP.
 * COVALink calls the same operations through `auth.api.*` from its own server
 * code, which these blocks don't affect:
 * - `/delete-user`, `/delete-user/callback`: deletion needs COVALink's typed
 *   confirmation, so it goes only through the account Server Action.
 * - `/verify-email` (GET, token in the query) and `/reset-password/<token>`
 *   (GET, token in the path): COVALink's links carry tokens in the fragment
 *   and submit them in request bodies; these URLs would put tokens in access
 *   logs.
 * `POST /reset-password` stays public for a token in the body; a `token` in
 * its query string is refused by `isBlockedAuthRequest`.
 */
export const BLOCKED_AUTH_PATHS = ["/delete-user", "/delete-user/callback", "/verify-email"] as const;

const AUTH_BASE = "/api/auth";

/**
 * Decodes a request path and normalizes letter case, backslashes, repeated or
 * trailing slashes and dot segments; `null` when it can't be decoded.
 */
function normalizePath(pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments: string[] = [];
  for (const part of decoded.toLowerCase().replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
}

/**
 * True when a request path (the URL's pathname, still percent-encoded) would
 * reach a blocked endpoint. Decoding, letter case, repeated or trailing
 * slashes and dot segments are normalized first, so spelling variants can't
 * slip past; a path that can't be decoded is blocked.
 */
export function isBlockedAuthPath(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (path === null) return true;
  if (!path.startsWith(`${AUTH_BASE}/`)) return false;
  const rest = path.slice(AUTH_BASE.length);
  if ((BLOCKED_AUTH_PATHS as readonly string[]).includes(rest)) return true;
  return rest.startsWith("/reset-password/") || rest.startsWith("/delete-user/") || rest.startsWith("/verify-email/");
}

/**
 * The external request guard for the Better Auth catch-all: a blocked path,
 * or `/reset-password` with a `token` query parameter. Better Auth
 * 1.7.14 reads `ctx.body.token || ctx.query?.token`, so the query form would
 * reset a password with the token in the request target, where proxies and
 * access logs keep it. Any method is refused: only POST is routed, but no
 * request should carry a reset token in its URL. The query is read exactly as
 * Better Auth's router reads it (`URL.searchParams`, decoded keys).
 */
export function isBlockedAuthRequest(request: Pick<Request, "url">): boolean {
  const url = new URL(request.url);
  if (isBlockedAuthPath(url.pathname)) return true;
  return normalizePath(url.pathname) === `${AUTH_BASE}/reset-password` && url.searchParams.has("token");
}
