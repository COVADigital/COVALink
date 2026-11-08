import "server-only";
import { resolveSessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isMediaKind, MAX_INPUT_BYTES } from "./constants";
import { ConcurrencyGate, DeadlineError, GateSaturatedError, withDeadline } from "./gate";
import { IntakeError, readBodyToFile } from "./intake";
import { ImageRejectedError, processImage, type ImageRejection } from "./pipeline";
import { isSameOrigin, sanitizeOriginalName } from "./request";
import { consumeUploadAttempt, mediaUsage, QUOTA_MESSAGE, storeAsset } from "./service";
import { mediaStorage, type MediaStorage } from "./storage";

/**
 * `POST /api/media?kind=avatar|background`. The body is one raw file.
 * Cheap checks run first and in this order, before a single body byte is
 * read: origin, session, kind, then the durable per-user upload attempt is
 * consumed (so rejected uploads count), then the declared length and the
 * quota. Only then is the body streamed, bounded, into a temp file, and
 * decoded under the process-wide decode gate. Every exit removes the intake
 * file.
 */

export const INTAKE_TIMEOUT_MS = 30_000;
export const PROCESS_DEADLINE_MS = 20_000;

export const decodeGate = new ConcurrencyGate({ maxActive: 2, maxQueued: 4, queueTimeoutMs: 10_000 });

export interface UploadDeps {
  storage: MediaStorage;
  gate: ConcurrencyGate;
  process: typeof processImage;
  intakeTimeoutMs: number;
  processDeadlineMs: number;
}

const defaults = (): UploadDeps => ({
  storage: mediaStorage(),
  gate: decodeGate,
  process: processImage,
  intakeTimeoutMs: INTAKE_TIMEOUT_MS,
  processDeadlineMs: PROCESS_DEADLINE_MS,
});

function reply(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}
const fail = (status: number, code: string, error: string, headers?: Record<string, string>) => reply(status, { error, code }, headers);

const REJECTIONS: Record<ImageRejection, [number, string]> = {
  empty: [400, "Choose an image file to upload."],
  too_large: [413, "This file is larger than 5 MB. Choose a smaller image."],
  unsupported: [415, "Use a JPEG, PNG or WebP image."],
  svg: [415, "SVG images aren't supported. Use a JPEG, PNG or WebP image."],
  gif: [415, "GIF images aren't supported. Use a JPEG, PNG or WebP image."],
  animated: [422, "Animated or multi-page images aren't supported. Use a still image."],
  trailing: [422, "This file has extra data after the image, so it can't be used. Save it again as a JPEG, PNG or WebP image."],
  malformed: [422, "This image couldn't be read. It may be damaged or not really an image."],
  dimensions: [422, "Images can be at most 8192 pixels wide or high."],
  pixels: [422, "This image has too many pixels (at most 40 megapixels)."],
  timeout: [422, "This image took too long to process. Try a smaller image."],
};

export async function handleMediaUpload(request: Request, overrides: Partial<UploadDeps> = {}): Promise<Response> {
  if (!isSameOrigin(request, new URL(env().APP_URL).origin)) return fail(403, "FORBIDDEN", "This request wasn't sent from COVALink.");
  const user = await resolveSessionUser(request.headers);
  if (!user) return fail(401, "UNAUTHENTICATED", "Your session has expired. Please sign in again.");
  const kind = new URL(request.url).searchParams.get("kind");
  if (!isMediaKind(kind)) return fail(400, "BAD_REQUEST", "Choose whether this is an avatar or a background image.");

  const attempt = await consumeUploadAttempt(user.id);
  if (!attempt.ok) {
    return fail(429, "RATE_LIMITED", "You've uploaded a lot of images in the last hour. Try again later.", {
      "retry-after": String(attempt.retryAfterSeconds),
    });
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_INPUT_BYTES)) {
    await request.body?.cancel().catch(() => {});
    return fail(413, "TOO_LARGE", REJECTIONS.too_large[1]);
  }
  const usage = await mediaUsage(user.id);
  if (usage.usedBytes >= usage.quotaBytes) {
    await request.body?.cancel().catch(() => {});
    return fail(413, "QUOTA", QUOTA_MESSAGE);
  }

  const deps = { ...defaults(), ...overrides };
  const originalName = sanitizeOriginalName(request.headers.get("x-upload-filename"));
  let intake: string | undefined;
  try {
    intake = await deps.storage.intakePath();
    const inputPath = intake;
    await readBodyToFile(request.body, inputPath, { maxBytes: MAX_INPUT_BYTES, timeoutMs: deps.intakeTimeoutMs });
    // The gate slot is held until the decode itself settles, even if the deadline answers first.
    const image = await withDeadline(
      deps.gate.run(() => deps.process(inputPath, kind)),
      deps.processDeadlineMs,
    );
    const stored = await storeAsset(user.id, kind, image, originalName, deps.storage);
    return reply(201, stored);
  } catch (err) {
    if (err instanceof IntakeError) {
      if (err.reason === "too_large") return fail(413, "TOO_LARGE", REJECTIONS.too_large[1]);
      if (err.reason === "timeout") return fail(408, "TIMEOUT", "The upload took too long. Check your connection and try again.");
      if (err.reason === "empty") return fail(400, "EMPTY", REJECTIONS.empty[1]);
      return fail(400, "ABORTED", "The upload was interrupted. Try again.");
    }
    if (err instanceof ImageRejectedError) {
      const [status, message] = REJECTIONS[err.reason];
      return fail(status, `IMAGE_${err.reason.toUpperCase()}`, message);
    }
    if (err instanceof GateSaturatedError || err instanceof DeadlineError) {
      return fail(503, "BUSY", "The server is busy processing other images. Try again in a moment.", { "retry-after": "5" });
    }
    if (err instanceof AppError) return fail(err.code === "LIMIT" ? 413 : 403, err.code === "LIMIT" ? "QUOTA" : err.code, err.message);
    logger.error({ err, userId: user.id, kind }, "Media upload failed");
    return fail(500, "ERROR", "Something went wrong. Please try again.");
  } finally {
    if (intake) await deps.storage.removeTemp(intake).catch((err) => logger.warn({ errCode: err?.code }, "Media intake cleanup failed"));
  }
}
