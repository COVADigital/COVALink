/**
 * Block-list validation problems, safe to send to the client.
 * `list` covers the whole list (not a list, too many blocks). Each item names
 * its position; `id` is set only for a well-formed, unique block id, so the
 * editor can attach the message to that block. `fields` maps config field
 * names to our own validation messages.
 */
export interface BlockListErrors {
  list: string[];
  items: { index: number; id?: string; message?: string; fields?: Record<string, string[]> }[];
}

/** Expected, user-facing failures. Anything else is logged and shown generically. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "VALIDATION" | "LIMIT" = "VALIDATION",
    readonly fieldErrors?: Record<string, string[]>,
    readonly blockErrors?: BlockListErrors,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** True when a Postgres unique constraint was violated (code 23505), optionally on a named constraint. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: string; constraint_name?: string; constraint?: string };
    if (pg.code === "23505") {
      return !constraint || pg.constraint_name === constraint || pg.constraint === constraint;
    }
  }
  return false;
}

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      fieldErrors?: Record<string, string[]>;
      blockErrors?: BlockListErrors;
      code?: AppError["code"];
    };
