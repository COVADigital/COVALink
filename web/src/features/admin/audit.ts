import "server-only";
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLogs, users } from "@/db/schema";
import { addDays, parseDay } from "@/features/analytics/range";
import { can } from "@/lib/auth/permissions";
import { AppError } from "@/lib/errors";
import { requireActor } from "./actor";
import { formatAuditEntry, type AuditDisplay } from "./audit-format";
import { AUDIT_CURSOR, AUDIT_PAGE_SIZE, auditQuerySchema, type AuditQuery } from "./queries";

/**
 * Audit-log reads (`audit.view`). Newest first by (created_at, id) with
 * keyset pagination: the cursor is the last row's exact timestamp
 * (microseconds, UTC) and id, so equal timestamps and new entries written
 * while paging can't duplicate or skip rows. Only formatted, allowlisted
 * fields leave this module; raw metadata never does. Emails of the people
 * involved are included only for actors who may also view users.
 */

export { AUDIT_PAGE_SIZE, auditQuerySchema, type AuditQuery } from "./queries";

export interface AuditPerson {
  id: string;
  name: string | null;
  email: string | null;
}

export interface AuditEntryView {
  id: number;
  at: Date;
  action: string;
  display: AuditDisplay;
  actor: AuditPerson | null;
  targetType: string | null;
  target: AuditPerson | null;
}

export interface AuditPage {
  query: AuditQuery;
  entries: AuditEntryView[];
  nextCursor: string | null;
}

export async function listAuditEntries(actorId: string, input: unknown): Promise<AuditPage> {
  const viewer = await requireActor(actorId, "audit.view");
  const parsed = auditQuerySchema.safeParse(input ?? {});
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Invalid filter", "VALIDATION");
  const query = parsed.data;
  const showEmails = can(viewer.role, "users.view");

  const filters: SQL[] = [];
  if (query.action !== "all") filters.push(eq(auditLogs.action, query.action));
  if (query.actor) filters.push(eq(auditLogs.actorId, query.actor));
  if (query.target) filters.push(eq(auditLogs.targetId, query.target));
  if (query.from) filters.push(sql`${auditLogs.createdAt} >= ${parseDay(query.from)!.toISOString()}::timestamptz`);
  if (query.to) filters.push(sql`${auditLogs.createdAt} < ${addDays(parseDay(query.to)!, 1).toISOString()}::timestamptz`);
  if (query.cursor) {
    const [, at, id] = AUDIT_CURSOR.exec(query.cursor)!;
    filters.push(sql`(${auditLogs.createdAt}, ${auditLogs.id}) < (${at}::timestamptz, ${id}::bigint)`);
  }

  const actorUser = alias(users, "actor_user");
  const targetUser = alias(users, "target_user");
  const rows = await db
    .select({
      id: auditLogs.id,
      at: auditLogs.createdAt,
      cursorAt: sql<string>`to_char(${auditLogs.createdAt} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      action: auditLogs.action,
      actorId: auditLogs.actorId,
      actorName: actorUser.name,
      actorEmail: actorUser.email,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      targetName: targetUser.name,
      targetEmail: targetUser.email,
      metadata: auditLogs.metadata,
    })
    .from(auditLogs)
    .leftJoin(actorUser, eq(actorUser.id, auditLogs.actorId))
    .leftJoin(targetUser, and(eq(auditLogs.targetType, "user"), eq(targetUser.id, auditLogs.targetId)))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(AUDIT_PAGE_SIZE + 1);

  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    query,
    entries: page.map((r) => ({
      id: r.id,
      at: r.at,
      action: r.action,
      display: formatAuditEntry(r.action, r.targetId, r.metadata),
      actor: r.actorId ? { id: r.actorId, name: r.actorName, email: showEmails ? r.actorEmail : null } : null,
      targetType: r.targetType,
      // Settings are named by the formatter (from the allowlisted catalog); only user targets are resolved.
      target: r.targetType === "user" && r.targetId ? { id: r.targetId, name: r.targetName, email: showEmails ? r.targetEmail : null } : null,
    })),
    nextCursor: rows.length > AUDIT_PAGE_SIZE && last ? `${last.cursorAt}_${last.id}` : null,
  };
}
