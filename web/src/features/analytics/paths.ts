/** Public analytics paths (client-safe). */

/** Tracked navigation for a published link block (`app/go/[profileId]/[blockId]`). */
export const clickPath = (profileId: string, blockId: string) => `/go/${profileId}/${blockId}`;

/** Tracked navigation for one item of a published social block (`app/go/[profileId]/[blockId]/[index]`). */
export const socialClickPath = (profileId: string, blockId: string, index: number) => `/go/${profileId}/${blockId}/${index}`;

/** The view beacon endpoint (`app/api/v`). */
export const BEACON_PATH = "/api/v";

/** The query parameter QR codes add to a profile URL; its only accepted value is `qr`. */
export const SOURCE_PARAM = "src";
