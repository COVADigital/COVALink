import { z } from "zod";
import { mediaKeyFromUrl, MEDIA_PATH_PREFIX } from "@/features/media/layout.mjs";
import { parseWebUrl } from "./url";

export { MEDIA_PATH_PREFIX };

/** True for an exact canonical uploaded-media URL, `/media/{uuid}.webp`. */
export const isMediaUrl = (v: unknown): v is string => mediaKeyFromUrl(v) !== null;

/** Image source: an uploaded asset (`/media/{uuid}.webp`, exactly) or an external https URL. */
export function parseImageSrc(raw: string): string | null {
  const v = raw.trim();
  if (isMediaUrl(v)) return v;
  const url = parseWebUrl(v);
  return url && url.protocol === "https:" ? url.toString() : null;
}

export const imageSrcSchema = z
  .string()
  .trim()
  .max(2048)
  .transform((v, ctx) => {
    const src = parseImageSrc(v);
    if (!src) {
      ctx.addIssue({ code: "custom", message: "Use an uploaded image or an https:// image URL" });
      return z.NEVER;
    }
    return src;
  });

export const optionalImageSrcSchema = z
  .string()
  .trim()
  .max(2048)
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const src = parseImageSrc(v);
    if (!src) {
      ctx.addIssue({ code: "custom", message: "Use an uploaded image or an https:// image URL" });
      return z.NEVER;
    }
    return src;
  });
