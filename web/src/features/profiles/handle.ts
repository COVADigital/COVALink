import { z } from "zod";

/**
 * Top-level path segments the app owns. A profile handle can never take one,
 * because public profiles are served from `/{handle}`.
 */
export const RESERVED_HANDLES = new Set([
  "about", "account", "admin", "api", "app", "assets", "auth", "billing", "blog", "dashboard",
  "docs", "download", "explore", "favicon.ico", "features", "forgot-password", "go", "health",
  "help", "home", "invite", "legal", "login", "logout", "media", "new", "pricing", "privacy",
  "profile", "profiles", "qr", "register", "reset-password", "robots.txt", "root", "settings", "setup",
  "signin", "signout", "signup", "sitemap.xml", "static", "status", "support", "system", "terms",
  "u", "uploads", "user", "users", "vcard", "verify-email", "www", "_next",
]);

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,29}$/;

/** Lowercase, trim, strip a leading "@", and remove characters outside the allowed set. */
export function normalizeHandle(input: string): string {
  return input
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle);
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle) && !isReservedHandle(handle);
}

export type HandleResolution = { kind: "ok"; handle: string } | { kind: "redirect"; handle: string } | { kind: "not_found" };

/** Longest raw route segment worth inspecting; anything longer is a 404 without further work. */
const MAX_RAW_SEGMENT = 64;

/**
 * Decides what a public `/{segment}` request means, before any cache tag or
 * database key is built from it. Only two cosmetic forms are redirected to the
 * canonical URL: a leading "@" and uppercase letters. Everything else that
 * isn't already a valid, unreserved handle is a 404; we deliberately don't
 * "fix" accents, spaces or punctuation into someone else's handle.
 * `segment` is the decoded route parameter (Next.js decodes once).
 */
export function resolveHandleParam(segment: string): HandleResolution {
  if (segment.length === 0 || segment.length > MAX_RAW_SEGMENT) return { kind: "not_found" };
  if (isValidHandle(segment)) return { kind: "ok", handle: segment };
  const canonical = segment.replace(/^@/, "").toLowerCase();
  if (canonical !== segment && isValidHandle(canonical)) return { kind: "redirect", handle: canonical };
  return { kind: "not_found" };
}

export const handleSchema = z
  .string()
  .transform(normalizeHandle)
  .pipe(
    z
      .string()
      .min(2, "Handles must be at least 2 characters")
      .max(30, "Handles can be at most 30 characters")
      .regex(HANDLE_PATTERN, "Use letters, numbers, hyphens or underscores, starting with a letter or number")
      .refine((h) => !isReservedHandle(h), "That handle is reserved"),
  );
