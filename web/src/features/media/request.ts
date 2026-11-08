import { MAX_ORIGINAL_NAME } from "./constants";

/** Pure request checks for the upload endpoint (unit-tested without a server). */

// Shared with the analytics beacon.
export { isSameOrigin } from "@/lib/security/origin";

/**
 * Display name for an upload, from the optional `X-Upload-Filename` header:
 * percent-decoded, last path segment only, no control/format/private-use
 * characters or line separators, whitespace collapsed, at most 100
 * characters. It is shown to the owner only and never used in a path.
 */
export function sanitizeOriginalName(raw: string | null): string | null {
  if (!raw || raw.length > 512) return null;
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  v = (v.split(/[\\/]/).pop() ?? "").replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
  v = Array.from(v).slice(0, MAX_ORIGINAL_NAME).join("").trim();
  return v || null;
}
