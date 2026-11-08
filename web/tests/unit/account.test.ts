import { describe, expect, it } from "vitest";
// @ts-expect-error Next.js ships its compiled path-to-regexp (the matcher behind next.config headers) without types.
import { pathToRegexp as untypedPathToRegexp } from "next/dist/compiled/path-to-regexp";
import { AUDIT_ACTIONS, formatAuditEntry } from "@/features/admin/audit-format";
import {
  ACCOUNT_NAME_MAX,
  changePasswordFormSchema,
  DELETE_CONFIRMATION,
  deleteAccountInput,
  emailRequestSchema,
  normalizeAccountName,
  resetPasswordFormSchema,
  tokenFromFragment,
  verifyEmailInput,
} from "@/features/account/schema";
import { BLOCKED_AUTH_PATHS, isBlockedAuthPath, isBlockedAuthRequest } from "@/lib/auth/blocked-paths";
import { productionConfigIssues } from "@/lib/config/production";
import { PAGE_HEADERS_SOURCE, PROFILE_HEADERS_SOURCE, securityHeaders, TOKEN_PAGE_HEADERS_SOURCE, tokenPageHeaders } from "@/lib/security/headers";
import { safeInternalPath } from "@/lib/validation/url";

const pathToRegexp = untypedPathToRegexp as (path: string) => RegExp;
const bs = String.fromCharCode(92);

describe("account name", () => {
  it("trims and accepts 1 to 80 characters, including non-Latin names and emoji", () => {
    expect(normalizeAccountName("  Ada Lovelace  ")).toBe("Ada Lovelace");
    expect(normalizeAccountName("a")).toBe("a");
    expect(normalizeAccountName("x".repeat(ACCOUNT_NAME_MAX))).toBe("x".repeat(ACCOUNT_NAME_MAX));
    expect(normalizeAccountName("  José Ñúñez 李雷 👩‍👩‍👧 ")).toBe("José Ñúñez 李雷 👩‍👩‍👧");
  });

  it("refuses empty, whitespace-only, oversized and non-string input", () => {
    for (const bad of ["", "   ", "\t\n", "x".repeat(ACCOUNT_NAME_MAX + 1), null, undefined, 42, ["Ada"], { name: "Ada" }]) {
      expect(normalizeAccountName(bad)).toBeNull();
    }
  });

  it("refuses control characters, line separators and bidirectional overrides", () => {
    const codes = [0x00, 0x07, 0x1b, 0x7f, 0x85, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069];
    for (const code of codes) expect(normalizeAccountName(`Ada${String.fromCharCode(code)}Admin`)).toBeNull();
    expect(normalizeAccountName("Ada\nAdmin")).toBeNull();
  });
});

describe("form and action schemas", () => {
  it("requires a valid email for reset and resend requests", () => {
    expect(emailRequestSchema.safeParse({ email: "ada@example.com" }).success).toBe(true);
    for (const email of ["", "ada", "ada@", 7]) expect(emailRequestSchema.safeParse({ email }).success).toBe(false);
  });

  it("checks new-password length and confirmation", () => {
    expect(resetPasswordFormSchema.safeParse({ password: "long-enough-pw", confirm: "long-enough-pw" }).success).toBe(true);
    expect(resetPasswordFormSchema.safeParse({ password: "short", confirm: "short" }).success).toBe(false);
    expect(resetPasswordFormSchema.safeParse({ password: "x".repeat(129), confirm: "x".repeat(129) }).success).toBe(false);
    expect(resetPasswordFormSchema.safeParse({ password: "long-enough-pw", confirm: "different-pw" }).success).toBe(false);
    const change = { currentPassword: "old", newPassword: "long-enough-pw", confirm: "long-enough-pw", signOutOthers: true };
    expect(changePasswordFormSchema.safeParse(change).success).toBe(true);
    expect(changePasswordFormSchema.safeParse({ ...change, currentPassword: "" }).success).toBe(false);
    expect(changePasswordFormSchema.safeParse({ ...change, confirm: "x" }).success).toBe(false);
  });

  it("accepts only the strict deletion and verification inputs", () => {
    expect(deleteAccountInput.safeParse({ password: "pw", confirmation: DELETE_CONFIRMATION }).success).toBe(true);
    expect(deleteAccountInput.safeParse({ password: "pw", confirmation: DELETE_CONFIRMATION, role: "admin" }).success).toBe(false);
    expect(deleteAccountInput.safeParse({ password: "", confirmation: DELETE_CONFIRMATION }).success).toBe(false);
    expect(deleteAccountInput.safeParse({ password: "x".repeat(129), confirmation: DELETE_CONFIRMATION }).success).toBe(false);
    expect(deleteAccountInput.safeParse({ password: "pw" }).success).toBe(false);
    expect(verifyEmailInput.safeParse({ token: "a.b.c" }).success).toBe(true);
    for (const bad of [{}, { token: "" }, { token: "x".repeat(2049) }, { token: 1 }, { token: "a", extra: 1 }]) {
      expect(verifyEmailInput.safeParse(bad).success).toBe(false);
    }
  });
});

describe("token fragments", () => {
  it("reads the token from the fragment only", () => {
    expect(tokenFromFragment("#token=abc123")).toBe("abc123");
    expect(tokenFromFragment("token=abc123")).toBe("abc123");
    expect(tokenFromFragment("#x=1&token=eyJ.a-b_c.d")).toBe("eyJ.a-b_c.d");
    expect(tokenFromFragment("#token=a%2Bb")).toBe("a+b");
  });

  it("returns null for a missing, empty, oversized or control-character token", () => {
    for (const hash of ["", "#", "#token=", "#other=1", `#token=${"x".repeat(2049)}`, "#token=a%0Ab", "#token=a%20b", "#token=a%00b"]) {
      expect(tokenFromFragment(hash)).toBeNull();
    }
  });
});

describe("blocked Better Auth paths and requests", () => {
  it("blocks deletion and token-in-URL endpoints in every spelling", () => {
    const blocked = [
      "/api/auth/delete-user",
      "/api/auth/delete-user/",
      "/api/auth/delete-user/callback",
      "/api/auth/DELETE-USER",
      "/api/auth//delete-user",
      "/api/auth/./delete-user",
      "/api/auth/x/../delete-user",
      "/api/auth/delete%2Duser",
      "/api/auth/delete%2duser%2Fcallback",
      `/api/auth/delete-user${bs}`,
      "/api/auth/verify-email",
      "/api/auth/verify-email/",
      "/api/auth/reset-password/abc123",
      "/api/auth/reset-password/abc123/",
      "/api/auth/RESET-PASSWORD/abc",
      "/api/auth/%E0%A4%A", // undecodable
    ];
    for (const p of blocked) expect(isBlockedAuthPath(p), p).toBe(true);
  });

  it("leaves every other endpoint, including the body-token reset, reachable", () => {
    for (const p of ["/api/auth/reset-password", "/api/auth/reset-password/", "/api/auth/request-password-reset", "/api/auth/send-verification-email", "/api/auth/sign-in/email", "/api/auth/change-password", "/api/auth/update-user", "/api/auth/get-session", "/delete-user", "/dashboard/account"]) {
      expect(isBlockedAuthPath(p), p).toBe(false);
    }
  });

  it("refuses a reset token in the query string for every method and spelling", () => {
    const blocked = [
      "/api/auth/reset-password?token=abc",
      "/api/auth/reset-password?token=",
      "/api/auth/reset-password?token",
      "/api/auth/reset-password?callbackURL=%2F&token=abc",
      "/api/auth/reset-password?token=a&token=b",
      "/api/auth/reset-password?%74oken=abc", // decoded key, as Better Auth's router reads it
      "/api/auth/RESET-PASSWORD?token=abc",
      "/api/auth/reset%2Dpassword?token=abc",
      "/api/auth/x/../reset-password?token=abc",
      "/api/auth//reset-password?token=abc",
      "/api/auth/reset-password/?token=abc",
    ];
    for (const method of ["POST", "GET", "PUT", "OPTIONS"]) {
      for (const p of blocked) expect(isBlockedAuthRequest(new Request(`https://links.example${p}`, { method })), `${method} ${p}`).toBe(true);
    }
  });

  it("keeps the body-token reset and other query strings reachable, and still blocks the blocked paths", () => {
    const req = (p: string, method = "POST") => new Request(`https://links.example${p}`, { method });
    for (const p of ["/api/auth/reset-password", "/api/auth/reset-password?", "/api/auth/reset-password?callbackURL=%2F", "/api/auth/reset-password?Token=abc", "/api/auth/reset-password?tokens=abc", "/api/auth/request-password-reset?token=abc", "/reset-password?token=abc"]) {
      expect(isBlockedAuthRequest(req(p)), p).toBe(false);
    }
    for (const p of ["/api/auth/delete-user", "/api/auth/delete-user/callback?token=x", "/api/auth/verify-email?token=x", "/api/auth/reset-password/abc?callbackURL=%2F"]) {
      expect(isBlockedAuthRequest(req(p)), p).toBe(true);
      expect(isBlockedAuthRequest(req(p, "GET")), p).toBe(true);
    }
  });

  it("lists exactly the exact-path blocks given to Better Auth's disabledPaths", () => {
    expect([...BLOCKED_AUTH_PATHS]).toEqual(["/delete-user", "/delete-user/callback", "/verify-email"]);
  });
});

describe("token-page headers", () => {
  const isDev = false;
  it("sends each header field exactly once, with no-referrer, no-store and noindex", () => {
    const headers = tokenPageHeaders({ isDev });
    const keys = headers.map((h) => h.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    const h = Object.fromEntries(headers.map(({ key, value }) => [key, value]));
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Cache-Control"]).toBe("no-store");
    expect(h["X-Robots-Tag"]).toBe("noindex");
    // Everything else matches the page headers.
    for (const { key, value } of securityHeaders({ isDev })) if (key !== "Referrer-Policy") expect(h[key]).toBe(value);
  });

  it("routes the token pages to the token rule only and every other page to the page rule only", () => {
    const page = pathToRegexp(PAGE_HEADERS_SOURCE);
    const token = pathToRegexp(TOKEN_PAGE_HEADERS_SOURCE);
    for (const p of ["/reset-password", "/verify-email"]) {
      expect(page.test(p), p).toBe(false);
      expect(token.test(p), p).toBe(true);
    }
    for (const p of ["/", "/login", "/forgot-password", "/dashboard/account"]) {
      expect(page.test(p), p).toBe(true);
      expect(token.test(p), p).toBe(false);
    }
    // Handle-shaped paths get the profile rule, not the token rule.
    for (const p of ["/reset-passwords", "/verify-email-now", "/alice"]) {
      expect([page.test(p), token.test(p), pathToRegexp(PROFILE_HEADERS_SOURCE).test(p)], p).toEqual([false, false, true]);
    }
    expect(page.test("/media/ab/cd/x.webp")).toBe(false);
  });
});

describe("production configuration: verification needs SMTP", () => {
  const SAFE = {
    NODE_ENV: "production",
    APP_URL: "https://links.example.com",
    DATABASE_URL: "postgresql://covalink:pw@db:5432/covalink",
    BETTER_AUTH_SECRET: "a".repeat(43),
    STORAGE_LOCAL_PATH: "/data/uploads",
  };
  const settings = (env: Record<string, string | undefined>) => productionConfigIssues(env).map((i) => i.setting);

  it("requires SMTP_HOST and SMTP_FROM only when verification is required", () => {
    expect(settings(SAFE)).toEqual([]);
    expect(settings({ ...SAFE, REQUIRE_EMAIL_VERIFICATION: "false" })).toEqual([]);
    expect(settings({ ...SAFE, REQUIRE_EMAIL_VERIFICATION: "true" })).toEqual(["SMTP_HOST", "SMTP_FROM"]);
    expect(settings({ ...SAFE, REQUIRE_EMAIL_VERIFICATION: "1", SMTP_HOST: "smtp.example.com" })).toEqual(["SMTP_FROM"]);
    expect(settings({ ...SAFE, REQUIRE_EMAIL_VERIFICATION: "true", SMTP_HOST: " ", SMTP_FROM: "a@example.com" })).toEqual(["SMTP_HOST"]);
    expect(settings({ ...SAFE, REQUIRE_EMAIL_VERIFICATION: "true", SMTP_HOST: "smtp.example.com", SMTP_FROM: "COVALink <a@example.com>" })).toEqual([]);
  });

  it("never echoes the values", () => {
    const text = JSON.stringify(productionConfigIssues({ ...SAFE, REQUIRE_EMAIL_VERIFICATION: "true", SMTP_HOST: "secret-host.internal" }));
    expect(text).not.toContain("secret-host");
  });
});

describe("account audit formatters", () => {
  it("labels the three account events and never reads their metadata", () => {
    const sneaky = { token: "tok-123", email: "ada@example.com", password: "pw", from: "x", to: "y" };
    for (const action of ["account.password_reset", "account.password_changed", "account.deleted"] as const) {
      expect(AUDIT_ACTIONS).toContain(action);
      const shown = formatAuditEntry(action, "user-1", sneaky);
      expect(shown.change).toBeNull();
      expect(shown.detail).toBeNull();
      expect(JSON.stringify(shown)).not.toMatch(/tok-123|ada@example|pw"/);
    }
    expect(formatAuditEntry("account.password_reset", "u", null).title).toBe("Password reset by email link");
    expect(formatAuditEntry("account.password_changed", "u", null).title).toBe("Password changed");
    expect(formatAuditEntry("account.deleted", "u", null).title).toBe("Account deleted by its owner");
  });
});

describe("safe internal redirects", () => {
  it("keeps only same-origin paths", () => {
    expect(safeInternalPath("/dashboard/account")).toBe("/dashboard/account");
    for (const bad of ["https://evil.example", "//evil.example", `/${bs}evil.example`, "javascript:alert(1)", " /x", null]) {
      expect(safeInternalPath(bad)).toBe("/dashboard");
    }
  });
});
