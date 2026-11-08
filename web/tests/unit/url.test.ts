import { describe, expect, it } from "vitest";
import { parseWebUrl, safeInternalPath, webUrlSchema } from "@/lib/validation/url";

describe("parseWebUrl", () => {
  it("accepts http and https URLs", () => {
    expect(parseWebUrl("https://example.com/a?b=1")?.toString()).toBe("https://example.com/a?b=1");
    expect(parseWebUrl("http://example.com")?.protocol).toBe("http:");
  });

  it("adds https:// when the scheme is missing", () => {
    expect(parseWebUrl("example.com/path")?.toString()).toBe("https://example.com/path");
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "mailto:a@example.com",
    "ftp://example.com",
  ])("rejects non-web protocol %s", (input) => {
    expect(parseWebUrl(input)).toBeNull();
  });

  it("rejects embedded credentials, whitespace, bare hosts and empty input", () => {
    expect(parseWebUrl("https://user:pass@example.com")).toBeNull();
    expect(parseWebUrl("https://exa mple.com")).toBeNull();
    expect(parseWebUrl("https://intranet")).toBeNull();
    expect(parseWebUrl("")).toBeNull();
    expect(parseWebUrl("   ")).toBeNull();
  });

  it("webUrlSchema normalizes valid input and reports invalid input", () => {
    expect(webUrlSchema.parse("example.com")).toBe("https://example.com/");
    expect(webUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(webUrlSchema.safeParse(`https://example.com/${"a".repeat(2050)}`).success).toBe(false);
  });
});

describe("safeInternalPath (post-login redirect)", () => {
  it("keeps same-origin relative paths", () => {
    expect(safeInternalPath("/dashboard")).toBe("/dashboard");
    expect(safeInternalPath("/admin?tab=users#x")).toBe("/admin?tab=users#x");
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "evil.example",
    "",
  ])("falls back for unsafe target %j", (input) => {
    expect(safeInternalPath(input)).toBe("/dashboard");
  });

  it("falls back for null/undefined and honors a custom fallback", () => {
    expect(safeInternalPath(null)).toBe("/dashboard");
    expect(safeInternalPath(undefined, "/")).toBe("/");
  });
});
