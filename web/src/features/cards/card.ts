import { z } from "zod";
import { qrSvg } from "@/features/analytics/qr";
import { plainName } from "@/features/audience/consent";
import { hasControlChars } from "@/features/blocks/contact-points";
import { BLOCK_INPUT_SCHEMAS } from "@/features/blocks/definitions";
import { contrastRatio, TEXT_CONTRAST } from "@/features/themes/contrast";

/**
 * The business card: a profile's display name, address and QR code on a
 * colour from a fixed palette. Pure and isomorphic: the card page's live
 * preview and the SVG download build the same file. The QR sits on a white
 * tile so it scans on every colour, and points at `qrTargetUrl` (visits count
 * as "QR code" in Analytics).
 */

/** Card colours. Each has a text colour (dark or white) with at least 4.5:1 contrast (tests/unit/cards.test.ts). */
export const CARD_COLORS = [
  { hex: "#c6f135", name: "Lime" },
  { hex: "#1f4d3a", name: "Forest" },
  { hex: "#4ade80", name: "Mint" },
  { hex: "#e9d5ff", name: "Lavender" },
  { hex: "#1e3a8a", name: "Navy" },
  { hex: "#f97316", name: "Orange" },
  { hex: "#1f2937", name: "Charcoal" },
  { hex: "#b91c1c", name: "Red" },
  { hex: "#7f1d1d", name: "Maroon" },
  { hex: "#0891b2", name: "Teal" },
  { hex: "#a21caf", name: "Purple" },
] as const;

export type CardColor = (typeof CARD_COLORS)[number]["hex"];

const HEXES = CARD_COLORS.map((c) => c.hex) as [CardColor, ...CardColor[]];

const cardFields = z
  .object({
    displayName: z
      .string()
      .refine((v) => !hasControlChars(v), "Remove line breaks, tabs and other control characters")
      .trim()
      .min(1, "Add a display name")
      .max(60, "Use at most 60 characters"),
    color: z.enum(HEXES, "Pick one of the colours"),
    /** Visitors who arrive from the card's QR code are offered a form to share their name and email (features/audience). */
    shareBack: z.boolean().default(false),
    /** Visitors who arrive from the card's QR code get a Save contact button with `contact` as a vCard. */
    saveContact: z.boolean().default(false),
    /** The Contact card block's fields, so the same validation and vCard builder apply. */
    contact: BLOCK_INPUT_SCHEMAS.contact.optional(),
  })
  .strict();

const needsContact = { message: "Add your contact details first", path: ["contact"] };

export const cardSchema = cardFields.refine((c) => !c.saveContact || !!c.contact, needsContact);

/**
 * A change to some of the settings; the action merges it into the saved card and checks the result with `cardSchema`.
 * No defaults here: a missing switch must stay as saved, not turn off.
 */
export const cardPatchSchema = z
  .object({
    displayName: cardFields.shape.displayName,
    color: cardFields.shape.color,
    shareBack: z.boolean(),
    saveContact: z.boolean(),
    contact: BLOCK_INPUT_SCHEMAS.contact,
  })
  .partial()
  .strict();

export type CardSettings = z.output<typeof cardSchema>;
export type CardContact = NonNullable<CardSettings["contact"]>;

/** The saved settings, or defaults: the profile's display name, the first colour, both extras off. Unreadable stored values fall back too. */
export function readCard(stored: unknown, fallbackName: string): CardSettings {
  const parsed = cardSchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  return { displayName: plainName(fallbackName).slice(0, 60) || "My card", color: CARD_COLORS[0].hex, shareBack: false, saveContact: false };
}

const DARK = "#18181b";
const LIGHT = "#ffffff";

/** Dark or white text, whichever contrasts more with `bg`. */
export function cardTextColor(bg: string): string {
  return contrastRatio(DARK, bg) >= contrastRatio(LIGHT, bg) ? DARK : LIGHT;
}

export const cardTextPasses = (bg: string) => contrastRatio(cardTextColor(bg), bg) >= TEXT_CONTRAST;

/** `host/handle`, as printed on the card. */
export const cardDisplayUrl = (appUrl: string, handle: string) => `${new URL(appUrl).host}/${handle}`;

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// shortcut: truncation counts code points against an average glyph width, so very wide glyphs can still overrun; measure with a font if that shows up.
function fit(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export const CARD_FILE_NAME = (handle: string) => `covalink-${handle}-card.svg`;

/** The card as a standalone SVG document (400 × 560). */
export function cardSvg({ displayName, displayUrl, qrTarget, color }: { displayName: string; displayUrl: string; qrTarget: string; color: string }): string {
  const ink = cardTextColor(color);
  const name = escapeXml(fit(plainName(displayName), 22));
  const url = escapeXml(fit(displayUrl, 34));
  const qr = qrSvg(qrTarget).replace("<svg ", '<svg x="88" y="264" width="224" height="224" ');
  const font = "font-family=\"Inter, ui-sans-serif, system-ui, sans-serif\"";
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 560" width="400" height="560" role="img">',
    `<title>${name}</title>`,
    `<rect width="400" height="560" rx="28" fill="${color}"/>`,
    `<g fill="${ink}" ${font}>`,
    '<text x="32" y="72" font-size="13" font-weight="600" letter-spacing="1.5">NAME</text>',
    `<text x="32" y="106" font-size="28" font-weight="700">${name}</text>`,
    '<text x="32" y="160" font-size="13" font-weight="600" letter-spacing="1.5">URL</text>',
    `<text x="32" y="190" font-size="18" font-weight="500">${url}</text>`,
    "</g>",
    '<rect x="80" y="256" width="240" height="240" rx="20" fill="#ffffff"/>',
    qr,
    "</svg>",
  ].join("");
}
