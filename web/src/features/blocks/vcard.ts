import { canonicalPhone } from "./contact-points";
import type { BlockConfig } from "./definitions";

/**
 * vCard 4.0 (RFC 6350) for contact blocks. Pure and isomorphic: the
 * public `/api/vcard/{profileId}/{blockId}` route and the editor preview's
 * download build the same file.
 *
 * - Text values escape backslash, comma, semicolon and line breaks
 *   (§3.4) and any other control character is removed: stored text can never
 *   break a line, so it can't start another property or card.
 * - URI values (`URL`, `TEL;VALUE=uri`) come from validated, serialized URLs
 *   and canonical phone numbers; anything that isn't printable ASCII is left out.
 * - Lines end with CRLF and are folded at 75 octets (§3.2) on code point
 *   boundaries, so a multi-byte UTF-8 character is never split.
 */

type Contact = BlockConfig<"contact">;

/** The public download of a published contact block (`app/api/vcard/[profileId]/[blockId]`). */
export const vcardPath = (profileId: string, blockId: string) => `/api/vcard/${profileId}/${blockId}`;

const OTHER_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const FOLD_OCTETS = 75;
const encoder = new TextEncoder();

/** RFC 6350 §3.4 TEXT escaping. */
export function escapeText(value: string): string {
  return value
    .replace(/\r\n|\r/g, "\n")
    .replace(OTHER_CONTROLS, "")
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\n/g, "\\n");
}

/** RFC 6350 §3.2 folding: at most 75 octets per physical line, never inside a character. */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let current = "";
  let octets = 0;
  // Continuation lines start with a space, which counts toward their 75 octets.
  let limit = FOLD_OCTETS;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > limit) {
      parts.push(current);
      current = "";
      octets = 0;
      limit = FOLD_OCTETS - 1;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** The formatted name: first and last name, else the organization. */
export function contactDisplayName(contact: { firstName?: string; lastName?: string; organization?: string }): string {
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
  return name || contact.organization?.trim() || "";
}

/** The vCard text, or null when the contact has no name or organization. */
export function buildVCard(contact: Contact): string | null {
  const fn = contactDisplayName(contact);
  if (!fn) return null;
  const lines = ["BEGIN:VCARD", "VERSION:4.0", `FN:${escapeText(fn)}`];
  if (contact.firstName || contact.lastName) {
    lines.push(`N:${escapeText(contact.lastName ?? "")};${escapeText(contact.firstName ?? "")};;;`);
  }
  if (contact.organization) lines.push(`ORG:${escapeText(contact.organization)}`);
  if (contact.jobTitle) lines.push(`TITLE:${escapeText(contact.jobTitle)}`);
  if (contact.email) lines.push(`EMAIL:${escapeText(contact.email)}`);
  const tel = contact.phone ? canonicalPhone(contact.phone) : null;
  if (tel) lines.push(`TEL;VALUE=uri:tel:${tel}`);
  if (contact.website && PRINTABLE_ASCII.test(contact.website)) lines.push(`URL:${contact.website}`);
  if (contact.note) lines.push(`NOTE:${escapeText(contact.note)}`);
  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** A `data:` URL of the card, for the editor preview's download (no request reaches the server). */
export function vcardDataUrl(contact: Contact): string | null {
  const card = buildVCard(contact);
  return card ? `data:text/vcard;charset=utf-8,${encodeURIComponent(card)}` : null;
}

const MAX_NAME = 60;

/**
 * Download file names: an ASCII fallback (letters, digits, `.`, `_`, `-`) and,
 * only when the name has non-ASCII characters, the UTF-8 name for RFC 6266
 * `filename*`. Neither can contain quotes, slashes, backslashes, control
 * characters or leading dots.
 */
export function vcardFileNames(contact: Contact): { ascii: string; utf8?: string } {
  const name = contactDisplayName(contact);
  const ascii =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, MAX_NAME)
      .replace(/[-.]+$/, "") || "contact";
  const utf8 = Array.from(
    name
      .replace(OTHER_CONTROLS, "")
      .replace(/[\n"\\/]/g, "")
      .replace(/^[\s.]+/, "")
      .trim(),
  )
    .slice(0, MAX_NAME)
    .join("")
    .trim();
  return /[^\x20-\x7e]/.test(utf8) ? { ascii: `${ascii}.vcf`, utf8: `${utf8}.vcf` } : { ascii: `${ascii}.vcf` };
}
