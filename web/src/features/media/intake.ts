import "server-only";
import { open, unlink } from "node:fs/promises";

/**
 * Bounded upload intake. Reads a request body stream chunk by chunk
 * into a new file (created exclusively, mode 0600) while counting bytes. The
 * stream is cancelled as soon as the count exceeds `maxBytes`, the deadline
 * passes or the reader fails; the body is never buffered whole and never
 * parsed by `formData()`/`blob()`/`arrayBuffer()`. On any failure the
 * partial file is removed before the error propagates.
 */

export type IntakeFailure = "too_large" | "timeout" | "aborted" | "empty";

export class IntakeError extends Error {
  constructor(readonly reason: IntakeFailure) {
    super(`Upload intake failed: ${reason}`);
    this.name = "IntakeError";
  }
}

/** The part of `FileHandle` intake writes through (injectable for tests). */
export interface ChunkWriter {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ bytesWritten: number }>;
}

/**
 * Writes all of `chunk`, continuing from each write's `bytesWritten` (a write
 * may persist only part of a buffer). A write that makes no progress is an
 * I/O failure, not a reason to loop.
 */
export async function writeFully(writer: ChunkWriter, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await writer.write(chunk, offset, chunk.byteLength - offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > chunk.byteLength - offset) {
      throw new Error("Upload intake write made no progress");
    }
    offset += bytesWritten;
  }
}

export async function readBodyToFile(
  body: ReadableStream<Uint8Array> | null,
  filePath: string,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number },
): Promise<number> {
  if (!body) throw new IntakeError("empty");
  const handle = await open(filePath, "wx", 0o600);
  const reader = body.getReader();
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array> | "timeout";
      try {
        step = await Promise.race([reader.read(), deadline]);
      } catch {
        throw new IntakeError("aborted");
      }
      if (step === "timeout") throw new IntakeError("timeout");
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) throw new IntakeError("too_large");
      await writeFully(handle, step.value);
    }
    if (total === 0) throw new IntakeError("empty");
    await handle.sync();
    return total;
  } catch (err) {
    // Stop the sender; the remaining body is discarded, never read.
    await reader.cancel().catch(() => {});
    await handle.close().catch(() => {});
    await unlink(filePath).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {}
    await handle.close().catch(() => {});
  }
}
