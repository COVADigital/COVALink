import { z } from "zod";
import { parseDay } from "@/features/analytics/range";
import { ROLES, type Role } from "@/lib/auth/permissions";
import { AUDIT_ACTIONS } from "./audit-format";

/**
 * Pure query contracts and rules of the admin console,
 * shared by the services and the unit tests. Every schema is strict: unknown
 * parameters are refused, not ignored.
 */

export const USERS_PAGE_SIZE = 25;
export const MAX_USERS_PAGE = 10_000;
export const AUDIT_PAGE_SIZE = 50;

export const userListQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional().default(""),
    role: z.enum(["all", ...ROLES]).optional().default("all"),
    status: z.enum(["all", "active", "disabled"]).optional().default("all"),
    page: z.coerce.number().int().min(1).max(MAX_USERS_PAGE).optional().default(1),
  })
  .strict();

export type UserListQuery = z.output<typeof userListQuerySchema>;

/** `ILIKE` pattern for a literal substring: `\`, `%` and `_` are escaped (used with `ESCAPE '\'`). */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Audit keyset cursor: the row's exact UTC timestamp (microseconds) and id. */
export const AUDIT_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_(\d{1,18})$/;

const optionalId = z.string().trim().regex(ACCOUNT_ID).optional().or(z.literal("").transform(() => undefined));
const day = z
  .string()
  .optional()
  .refine((v) => v === undefined || v === "" || parseDay(v) !== null, "Use a date like 2026-11-02")
  .transform((v) => (v ? v : undefined));

export const auditQuerySchema = z
  .object({
    action: z.enum(["all", ...AUDIT_ACTIONS]).optional().default("all"),
    actor: optionalId,
    target: optionalId,
    from: day,
    to: day,
    cursor: z.string().regex(AUDIT_CURSOR).optional().or(z.literal("").transform(() => undefined)),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: "The start date must be on or before the end date", path: ["from"] });

export type AuditQuery = z.output<typeof auditQuerySchema>;

/**
 * No-op rules: a request that wouldn't change state writes and audits
 * nothing. (`setSetting` applies the same rule to the effective setting value.)
 */
export const isNoOpBan = (currentlyDisabled: boolean, disable: boolean) => currentlyDisabled === disable;
export const isNoOpRole = (current: Role, next: Role) => current === next;
