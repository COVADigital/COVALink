import { renderSVG } from "uqr";
import { isValidHandle } from "@/features/profiles/handle";
import { SOURCE_PARAM } from "./paths";

/**
 * QR codes for a profile, encoded by `uqr` (MIT, a port of Project
 * Nayuki's generator; no custom encoder). The code holds
 * `APP_URL/{handle}?src=qr`, so visits from it are reported with the `qr`
 * source; the page's canonical URL stays `APP_URL/{handle}`. A printed code
 * is tied to the handle: after a rename it points at the old handle (a 404,
 * or someone else's profile if the old handle is claimed again).
 */

export function qrTargetUrl(appUrl: string, handle: string): string {
  if (!isValidHandle(handle)) throw new Error("qrTargetUrl: invalid handle");
  const url = new URL(`/${handle}`, appUrl);
  url.searchParams.set(SOURCE_PARAM, "qr");
  return url.toString();
}

/** A standalone SVG document: medium error correction, the standard 4-module quiet zone. */
export function qrSvg(text: string): string {
  return renderSVG(text, { ecc: "M", border: 4, pixelSize: 8 });
}

export const qrFileName = (handle: string) => `covalink-${handle}-qr.svg`;
