/**
 * Isomorphic pieces of the Subscribe block: the fixed consent line shown under
 * the form (and stored with each contact), and the endpoint paths.
 */
export const SUBSCRIBE_PATH = "/api/subscribe";
export const SUBSCRIBE_CONFIRM_PATH = "/api/subscribe/confirm";
export const SUBSCRIBE_REMOVE_PATH = "/api/subscribe/remove";

/**
 * The display name as plain one-line text: control characters (line breaks included) become spaces, and invisible
 * format characters (direction overrides, zero-width marks) are dropped so the quoted name can't be visually spoofed.
 */
export const plainName = (displayName: string) =>
  displayName.replace(/\p{Cf}+/gu, "").replace(/[\p{Cc}\s]+/gu, " ").trim();

export function consentText(displayName: string): string {
  return `By subscribing, you agree to share your email with ${plainName(displayName)}. You can remove it at any time.`;
}
