import "server-only";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { users } from "@/db/schema";
import { can, isRole, type Capability, type Role } from "@/lib/auth/permissions";
import { AppError } from "@/lib/errors";

export interface Actor {
  id: string;
  role: Role;
}

export const FORBIDDEN_MESSAGE = "You don't have permission to do that.";

/**
 * The authorization step of every administrative read: the actor's
 * role and ban state are re-read from PostgreSQL on each call, never taken
 * from the session object, the client or a cache. A missing, banned or
 * unknown-role actor, or one without `capability`, is FORBIDDEN.
 */
export async function requireActor(actorId: unknown, capability: Capability, q: Tx | typeof db = db): Promise<Actor> {
  if (typeof actorId !== "string" || actorId.length === 0 || actorId.length > 64) throw new AppError(FORBIDDEN_MESSAGE, "FORBIDDEN");
  const [row] = await q.select({ role: users.role, banned: users.banned }).from(users).where(eq(users.id, actorId)).limit(1);
  if (!row || row.banned || !isRole(row.role) || !can(row.role, capability)) throw new AppError(FORBIDDEN_MESSAGE, "FORBIDDEN");
  return { id: actorId, role: row.role };
}
