import "server-only";
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { auditLogs, profiles, sessions, users } from "@/db/schema";
import { invalidateOwnerPublicProfilesBestEffort } from "@/features/profiles/cache";
import { can, canChangeRole, canModerateUser, isRole, type Role } from "@/lib/auth/permissions";
import { AppError } from "@/lib/errors";
import { FORBIDDEN_MESSAGE, requireActor } from "./actor";
import { containsPattern, isNoOpBan, isNoOpRole, USERS_PAGE_SIZE, userListQuerySchema, type UserListQuery } from "./queries";

/**
 * Privileged user management. Every function takes only the
 * acting user's id: the actor's role and ban state are re-read from the
 * database (inside the transaction, row-locked, for mutations), and every
 * successful change is audit-logged in the same transaction. A request that
 * wouldn't change anything is a no-op: nothing is written and nothing is
 * audited.
 */

export interface MutationResult {
  changed: boolean;
}

const idSchema = z.string().min(1).max(64);

/**
 * Loads and locks the actor and target. Authorization comes before existence:
 * a missing, banned or unknown-role actor, or one without
 * `users.manage`, gets the same FORBIDDEN whether the target exists, is
 * unknown or is malformed, so the response can't be used to probe account
 * ids. Only an authorized actor learns NOT_FOUND. The finer per-target rules
 * (`canModerateUser`, `canChangeRole`) are the caller's, after this.
 */
async function loadPair(tx: Tx, actorId: unknown, targetId: unknown) {
  if (!idSchema.safeParse(actorId).success) throw new AppError(FORBIDDEN_MESSAGE, "FORBIDDEN");
  const validTarget = idSchema.safeParse(targetId).success;
  const ids = (validTarget ? [actorId, targetId] : [actorId]) as string[];
  // Row locks prevent a concurrent role change from invalidating this check.
  // One statement locks both rows, as before, so two actors can't deadlock.
  const rows = await tx.select({ id: users.id, role: users.role, banned: users.banned }).from(users).where(inArray(users.id, ids)).for("update");
  const actor = rows.find((r) => r.id === actorId);
  if (!actor || actor.banned || !isRole(actor.role) || !can(actor.role, "users.manage")) throw new AppError(FORBIDDEN_MESSAGE, "FORBIDDEN");
  const target = validTarget ? rows.find((r) => r.id === targetId) : undefined;
  if (!target || !isRole(target.role)) throw new AppError("User not found", "NOT_FOUND");
  return {
    actor: { id: actor.id, role: actor.role as Role },
    target: { id: target.id, role: target.role as Role, banned: target.banned },
  };
}

/**
 * Disables (bans) or re-enables a user. Disabling deletes every session of
 * that user, so they are signed out everywhere and must sign in again after
 * being re-enabled. Public profiles of a disabled owner are 404 on the next
 * request (the live check reads ban state); cache entries are evicted
 * too, best effort. Already in the requested state: no-op.
 */
export async function setUserBanned(actorId: string, targetId: string, banned: boolean, reason?: string): Promise<MutationResult> {
  if (typeof banned !== "boolean") throw new AppError("Invalid request", "VALIDATION");
  const changed = await db.transaction(async (tx) => {
    const { actor, target } = await loadPair(tx, actorId, targetId);
    if (!canModerateUser(actor, target)) throw new AppError(FORBIDDEN_MESSAGE, "FORBIDDEN");
    if (isNoOpBan(target.banned, banned)) return false;
    await tx.update(users).set({ banned, banReason: banned ? (reason ?? null) : null }).where(eq(users.id, targetId));
    if (banned) await tx.delete(sessions).where(eq(sessions.userId, targetId));
    await tx.insert(auditLogs).values({
      actorId,
      action: banned ? "user.ban" : "user.unban",
      targetType: "user",
      targetId,
      metadata: reason ? { reason } : null,
    });
    return true;
  });
  if (changed) await invalidateOwnerPublicProfilesBestEffort(targetId, undefined, { operation: banned ? "user.ban" : "user.unban" });
  return { changed };
}

/** Changes a user's role within the escalation rules (`canChangeRole`). The same role again: no-op. */
export async function changeUserRole(actorId: string, targetId: string, nextRole: unknown): Promise<MutationResult> {
  if (!isRole(nextRole)) throw new AppError("Unknown role", "VALIDATION");
  const changed = await db.transaction(async (tx) => {
    const { actor, target } = await loadPair(tx, actorId, targetId);
    if (!canChangeRole(actor, target, nextRole)) throw new AppError(FORBIDDEN_MESSAGE, "FORBIDDEN");
    if (isNoOpRole(target.role, nextRole)) return false;
    await tx.update(users).set({ role: nextRole }).where(eq(users.id, targetId));
    await tx.insert(auditLogs).values({
      actorId,
      action: "user.role_change",
      targetType: "user",
      targetId,
      metadata: { from: target.role, to: nextRole },
    });
    return true;
  });
  return { changed };
}

// ------------------------------------------------------------------ reads --

export { USERS_PAGE_SIZE, userListQuerySchema, containsPattern, type UserListQuery } from "./queries";

export interface UserListItem {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  profileCount: number;
}

export interface UserListPage {
  query: UserListQuery;
  items: UserListItem[];
  total: number;
  pageCount: number;
}

/**
 * One page of users (`users.view`), newest accounts first with the id as a
 * tie-breaker, so pages are stable even for equal creation times.
 */
export async function listUsers(actorId: string, input: unknown): Promise<UserListPage> {
  await requireActor(actorId, "users.view");
  const parsed = userListQuerySchema.safeParse(input ?? {});
  if (!parsed.success) throw new AppError("Invalid search", "VALIDATION");
  const query = parsed.data;
  const filters: SQL[] = [];
  if (query.q) {
    const pattern = containsPattern(query.q);
    filters.push(or(sql`${users.name} ilike ${pattern} escape '\\'`, sql`${users.email} ilike ${pattern} escape '\\'`)!);
  }
  if (query.role !== "all") filters.push(eq(users.role, query.role));
  if (query.status !== "all") filters.push(eq(users.banned, query.status === "disabled"));
  const where = filters.length ? and(...filters) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        disabled: users.banned,
        createdAt: users.createdAt,
        // Qualified explicitly: inside a subquery Drizzle prints bare column names.
        profileCount: sql<number>`(select count(*) from profiles p where p.owner_id = "users"."id")::int`,
      })
      .from(users)
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(USERS_PAGE_SIZE)
      .offset((query.page - 1) * USERS_PAGE_SIZE),
    db.select({ total: count() }).from(users).where(where),
  ]);
  return {
    query,
    items: rows.map((r) => ({ ...r, role: isRole(r.role) ? r.role : "user" })),
    total,
    pageCount: Math.max(1, Math.ceil(total / USERS_PAGE_SIZE)),
  };
}

export interface UserDetail {
  id: string;
  name: string;
  email: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  profiles: { id: string; handle: string; label: string; isPublished: boolean }[];
  /** What this actor may do to this user, computed with the same rules the mutations enforce. */
  allowed: { disable: boolean; enable: boolean; roles: Role[] };
}

export async function getUserDetail(actorId: string, targetId: string): Promise<UserDetail> {
  const actor = await requireActor(actorId, "users.view");
  if (!idSchema.safeParse(targetId).success) throw new AppError("User not found", "NOT_FOUND");
  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, disabled: users.banned, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  if (!row || !isRole(row.role)) throw new AppError("User not found", "NOT_FOUND");
  const owned = await db
    .select({ id: profiles.id, handle: profiles.handle, label: profiles.label, isPublished: profiles.isPublished })
    .from(profiles)
    .where(eq(profiles.ownerId, row.id))
    .orderBy(asc(profiles.createdAt), asc(profiles.id));
  const target = { id: row.id, role: row.role };
  const moderate = canModerateUser(actor, target);
  return {
    ...row,
    role: row.role,
    profiles: owned,
    allowed: {
      disable: moderate && !row.disabled,
      enable: moderate && row.disabled,
      roles: (["user", "admin"] as const).filter((r) => r !== row.role && canChangeRole(actor, target, r)),
    },
  };
}
