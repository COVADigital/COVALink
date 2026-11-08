import { z } from "zod";

const ALLOWED_LINK_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Accepts a user-entered web address. Adds `https://` when the scheme is
 * missing and rejects anything other than http(s) (e.g. `javascript:`, `data:`).
 */
export function parseWebUrl(raw: string): URL | null {
  const value = raw.trim();
  if (!value || /\s/.test(value)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!ALLOWED_LINK_PROTOCOLS.has(url.protocol)) return null;
  // Public links must point at a real domain or IP, not a bare word like "https://foo".
  if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) return null;
  if (url.username || url.password) return null;
  return url;
}

/**
 * Stricter rules for outbound link destinations (link blocks, Markdown links).
 * `parseWebUrl` would normalize ambiguous spellings such as `//host`, `\\host`,
 * `https:\\host` or `https:host` into an absolute URL; for links we reject
 * them instead, together with control characters, so what is stored is what
 * the owner clearly typed.
 */
export function parseLinkUrl(raw: string): URL | null {
  const value = raw.trim();
  if (value.length > 2048) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  if (value.startsWith("/")) return null;
  // An explicit scheme must be followed by exactly "//" and then the host:
  // "https:evil.com", "https:/evil.com" and "https:///evil.com" are refused.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (scheme && !/^\/\/[^/]/.test(value.slice(scheme[0].length))) return null;
  return parseWebUrl(value);
}

export const linkUrlSchema = z
  .string()
  .trim()
  .min(1, "Add a web address")
  .max(2048, "URL is too long")
  .transform((v, ctx) => {
    const url = parseLinkUrl(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "Enter a valid http(s) address, like example.com" });
      return z.NEVER;
    }
    return url.toString();
  });

export const webUrlSchema = z
  .string()
  .trim()
  .max(2048, "URL is too long")
  .transform((v, ctx) => {
    const url = parseWebUrl(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "Enter a valid http(s) address" });
      return z.NEVER;
    }
    return url.toString();
  });

/** Optional variant: empty string becomes undefined. */
export const optionalWebUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const url = parseWebUrl(v);
    if (!url) {
      ctx.addIssue({ code: "custom", message: "Enter a valid http(s) address" });
      return z.NEVER;
    }
    return url.toString();
  });

/** Same-origin relative path, used for post-login redirects. Prevents open redirects. */
export function safeInternalPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  return raw;
}
