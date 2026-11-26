import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileBlocks } from "@/components/profile/blocks";
import { consentText, plainName } from "@/features/audience/consent";
import { csvRow } from "@/features/audience/csv";
import type { Block } from "@/features/blocks/block";
import { BLOCK_DEFINITIONS, BLOCK_INPUT_SCHEMAS } from "@/features/blocks/definitions";

describe("CSV export rows", () => {
  it("quotes per RFC 4180 and neutralizes spreadsheet formulas", () => {
    expect(csvRow(["a@example.com", "2026-11-20T00:00:00.000Z", "plain"])).toBe("a@example.com,2026-11-20T00:00:00.000Z,plain");
    expect(csvRow(['say "hi", ok'])).toBe('"say ""hi"", ok"');
    for (const cell of ["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(csvRow([cell]).replace(/^"/, "")).toMatch(/^'/);
    expect(csvRow(["line\nbreak"])).toBe('"line\nbreak"');
  });

  it("keeps a cell with a semicolon as one quoted field", () => {
    expect(csvRow(["a;b"])).toBe('"a;b"');
    expect(csvRow(["x;=1+1", "ok"])).toBe('"x;=1+1",ok');
    expect(csvRow(['=a;"b"'])).toBe('"\'=a;""b"""');
  });
});

describe("display name in sign-up text", () => {
  it("becomes one plain line: control characters and line breaks can't add email headers or lines", () => {
    expect(plainName("Ada\r\nBcc: x@example.com")).toBe("Ada Bcc: x@example.com");
    expect(plainName(" A\u0000d\ta ")).toBe("A d a");
    expect(consentText("Ada\nLovelace")).toContain("with Ada Lovelace.");
    expect(plainName("Ada\u202eecalevol\u200b")).toBe("Adaecalevol"); // Direction override and zero-width space dropped.
  });
});

describe("subscribe block", () => {
  it("validates its three fields strictly, with usable defaults", () => {
    const schema = BLOCK_INPUT_SCHEMAS.subscribe;
    expect(schema.safeParse(BLOCK_DEFINITIONS.subscribe.defaults()).success).toBe(true);
    expect(schema.safeParse({ title: "", buttonLabel: "Go" }).success).toBe(false);
    expect(schema.safeParse({ title: "Join", buttonLabel: "Go", extra: 1 }).success).toBe(false);
    expect(schema.safeParse({ title: "Join\nnow", buttonLabel: "Go" }).success).toBe(false);
    expect(schema.safeParse({ title: "x".repeat(81), buttonLabel: "Go" }).success).toBe(false);
  });

  const block = { id: "00000000-0000-4000-8000-000000000001", type: "subscribe", visible: true, config: { title: "Join my list", buttonLabel: "Sign up" } } as Block;
  const render = (ctx: Parameters<typeof ProfileBlocks>[0]["ctx"]) => renderToStaticMarkup(createElement(ProfileBlocks, { blocks: [block], ctx }));

  it("is hidden on the public page unless sign-ups can work, and inert in the preview", () => {
    const base = { openLinksInNewTab: false, displayName: "Alice", clickTrackingProfileId: "00000000-0000-4000-8000-000000000009" };
    expect(render({ ...base, mode: "public" })).toBe("");
    expect(render({ ...base, mode: "public", subscribeLive: false })).toBe("");
    const live = render({ ...base, mode: "public", subscribeLive: true });
    expect(live).toContain("Join my list");
    expect(live).toContain(consentText("Alice"));
    expect(live).toContain('autoComplete="email"');
    // Without JavaScript the browser submits natively; POST keeps the address out of the URL.
    expect(live).toMatch(/<form[^>]*method="post"/);
    expect(live).not.toMatch(/<input[^>]*type="email"[^>]*disabled/);
    const preview = render({ ...base, mode: "preview" });
    expect(preview).toMatch(/<input[^>]*type="email"[^>]*disabled/);
  });
});
