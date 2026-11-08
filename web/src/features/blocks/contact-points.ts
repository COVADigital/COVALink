/**
 * Email and telephone destinations for blocks. Pure and isomorphic:
 * the block schemas, the shared renderer and the vCard generator use the
 * same rules, so what is stored is what is linked.
 */

/** C0/C1 controls (CR, LF, tab, NUL, DEL, …) and the Unicode line/paragraph separators. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;

/** Like `CONTROL`, but a line feed is allowed (multi-line notes). */
const CONTROL_EXCEPT_LF = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

export const hasControlChars = (value: string) => CONTROL.test(value);
export const hasControlCharsExceptLf = (value: string) => CONTROL_EXCEPT_LF.test(value);

export const PHONE_MAX_LENGTH = 32;
/** Digits with spaces, parentheses, periods and hyphens; one optional leading `+`. */
const PHONE_SHAPE = /^\+?[0-9 ().-]+$/;
const PHONE_CANONICAL = /^\+?[0-9]{4,15}$/;

/**
 * The canonical form of a phone number (an optional leading `+` and 4–15
 * digits), or null. Refused: control characters, letters and extension
 * markers (`x`, `,`, `;`, `#`, `*`), a second or misplaced `+`, and values
 * that are only punctuation.
 */
export function canonicalPhone(raw: string): string | null {
  if (CONTROL.test(raw)) return null;
  const value = raw.trim();
  if (value.length > PHONE_MAX_LENGTH || !PHONE_SHAPE.test(value)) return null;
  const canonical = value.replace(/[ ().-]/g, "");
  return PHONE_CANONICAL.test(canonical) ? canonical : null;
}

export function telHref(phone: string): string | null {
  const canonical = canonicalPhone(phone);
  return canonical ? `tel:${canonical}` : null;
}

/**
 * The characters `z.email()` accepts (checked again here): none of them can
 * end the address part of a `mailto:` URI or start a header (`?`, `&`, `#`,
 * `%`, whitespace).
 */
const MAILTO_ADDRESS = /^[A-Za-z0-9._'+-]+@[A-Za-z0-9.-]+$/;
export const EMAIL_MAX_LENGTH = 254;
export const SUBJECT_MAX_LENGTH = 120;

/**
 * `mailto:{address}` with an optional subject encoded as a query value, so
 * it can never introduce another header; null for anything else.
 */
export function mailtoHref(email: string, subject?: string): string | null {
  if (email.length > EMAIL_MAX_LENGTH || !MAILTO_ADDRESS.test(email)) return null;
  if (subject === undefined || subject === "") return `mailto:${email}`;
  if (subject.length > SUBJECT_MAX_LENGTH || CONTROL.test(subject)) return null;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}`;
}
