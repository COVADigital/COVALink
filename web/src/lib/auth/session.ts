import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "./server";
import { can, isRole, type Capability, type Role } from "./permissions";

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: Role;
}

/**
 * Resolves the signed-in user from request headers. Better Auth reads the
 * session and user rows from PostgreSQL on every call (cookie caching is not
 * enabled), so `role` and `banned` reflect current database state. Banned
 * users are treated as signed out even if a session row survives; expired
 * sessions resolve to null.
 */
export async function resolveSessionUser(requestHeaders: Headers): Promise<CurrentUser | null> {
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return null;
  const u = session.user as typeof session.user & { role?: unknown; banned?: boolean | null };
  if (u.banned) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    role: isRole(u.role) ? u.role : "user",
  };
}

/** Request-scoped (React `cache`) current user. Never cached across requests. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => resolveSessionUser(await headers()));

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireCapability(capability: Capability): Promise<CurrentUser> {
  const user = await requireUser();
  if (!can(user.role, capability)) redirect("/dashboard?denied=1");
  return user;
}
