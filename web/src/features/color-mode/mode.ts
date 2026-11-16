export const COLOR_MODES = ["system", "light", "dark"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];
export const COLOR_MODE_COOKIE = "covalink_color_mode";

/** Only an exact "light" or "dark" is a stored choice; anything else follows the system. */
export function parseColorMode(v: unknown): ColorMode {
  return v === "light" || v === "dark" ? v : "system";
}
