import jsQR from "jsqr";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { qrTargetUrl } from "@/features/analytics/qr";
import { CARD_COLORS, CARD_FILE_NAME, cardDisplayUrl, cardPatchSchema, cardSchema, cardSvg, cardTextPasses, readCard } from "@/features/cards/card";

const target = qrTargetUrl("https://links.example.com", "alice");
const base = { displayUrl: cardDisplayUrl("https://links.example.com", "alice"), qrTarget: target };

describe("business card", () => {
  it("has readable text on every palette colour", () => {
    for (const c of CARD_COLORS) expect(cardTextPasses(c.hex), c.name).toBe(true);
  });

  it("escapes the name, drops control and format characters, and cuts long text with an ellipsis", () => {
    const svg = cardSvg({ ...base, displayName: 'A<b>&"c"\u202e\nx', color: CARD_COLORS[0].hex });
    expect(svg).toContain("A&lt;b&gt;&amp;&quot;c&quot; x");
    expect(svg).not.toMatch(/<script|on\w+=|href=|<foreignObject|<style|<b>/i);
    expect(cardSvg({ ...base, displayName: "x".repeat(60), color: CARD_COLORS[0].hex })).toContain(`${"x".repeat(21)}…`);
    expect(base.displayUrl).toBe("links.example.com/alice");
    expect(CARD_FILE_NAME("alice")).toBe("covalink-alice-card.svg");
  });

  it("carries a QR code that an independent decoder (jsQR) reads back as the page address", async () => {
    const svg = cardSvg({ ...base, displayName: "Alice", color: "#1f2937" });
    const { data, info } = await sharp(Buffer.from(svg)).resize(800, 1120, { kernel: "nearest" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height)?.data).toBe(target);
  });

  it("accepts only palette colours and one-line names", () => {
    expect(cardSchema.safeParse({ displayName: " Alice ", color: "#c6f135" })).toEqual({ success: true, data: { displayName: "Alice", color: "#c6f135", shareBack: false, saveContact: false } });
    expect(cardSchema.safeParse({ displayName: "Alice", color: "#123456" }).success).toBe(false);
    expect(cardSchema.safeParse({ displayName: "A\nB", color: "#c6f135" }).success).toBe(false);
    expect(cardSchema.safeParse({ displayName: "", color: "#c6f135" }).success).toBe(false);
    expect(cardSchema.safeParse({ displayName: "Alice", color: "#c6f135", extra: 1 }).success).toBe(false);
  });

  it("falls back to the profile name and the first colour when nothing valid is saved", () => {
    expect(readCard(null, "Alice\u202e")).toEqual({ displayName: "Alice", color: CARD_COLORS[0].hex, shareBack: false, saveContact: false });
    expect(readCard({ displayName: "Bo", color: "#000000" }, "Alice").displayName).toBe("Alice");
    expect(readCard({ displayName: "Bo", color: "#b91c1c" }, "Alice")).toEqual({ displayName: "Bo", color: "#b91c1c", shareBack: false, saveContact: false });
  });
});

describe("business card changes", () => {
  it("a partial change carries only what it names, so missing switches stay as saved", () => {
    expect(cardPatchSchema.parse({ color: "#c6f135" })).toEqual({ color: "#c6f135" });
    expect(cardPatchSchema.safeParse({ shareBack: "yes" }).success).toBe(false);
  });
});
