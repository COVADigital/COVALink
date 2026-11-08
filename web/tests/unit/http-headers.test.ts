import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "@/lib/security/headers";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `));

describe("content security policy", () => {
  const prod = contentSecurityPolicy({ isDev: false });

  it("locks down framing, plugins, base URI and form targets", () => {
    expect(directive(prod, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(prod, "object-src")).toBe("object-src 'none'");
    expect(directive(prod, "base-uri")).toBe("base-uri 'self'");
    expect(directive(prod, "form-action")).toBe("form-action 'self'");
    expect(directive(prod, "frame-src")).toBe("frame-src 'none'");
    expect(directive(prod, "default-src")).toBe("default-src 'self'");
  });

  it("allows third-party https sources for images only (owner avatars)", () => {
    expect(directive(prod, "img-src")).toBe("img-src 'self' data: blob: https:");
    const withoutImg = prod
      .split(";")
      .filter((d) => !d.trim().startsWith("img-src"))
      .join(";");
    expect(withoutImg).not.toMatch(/https?:/);
    expect(prod).not.toContain("*");
    expect(prod).not.toMatch(/\bhttp:/);
  });

  it("never allows eval in production, only in development", () => {
    expect(prod).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy({ isDev: true })).toContain("'unsafe-eval'");
  });

  it("documents the one accepted weakness: inline scripts/styles (Next.js PPR)", () => {
    expect(directive(prod, "script-src")).toBe("script-src 'self' 'unsafe-inline'");
    expect(directive(prod, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
  });
});

describe("securityHeaders", () => {
  it("includes the expected hardening headers", () => {
    const h = Object.fromEntries(securityHeaders({ isDev: false }).map(({ key, value }) => [key, value]));
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Content-Security-Policy"]).toBe(contentSecurityPolicy({ isDev: false }));
  });
});
