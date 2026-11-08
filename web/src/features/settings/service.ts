import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { auditLogs, systemSettings, users } from "@/db/schema";
import { can, isRole, type Capability } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * Installation-wide settings stored in `system_settings`. Each key has a schema,
 * an env-derived default (so a fresh install works before anyone saves), and
 * the capability required to change it. Settings that decide who can obtain an
 * account are security settings (`settings.manageSecurity`, super admin only).
 * Secrets (SMTP password, auth secret) are never stored here.
 */
const SETTINGS = {
  "registration.enabled": {
    schema: z.boolean(),
    default: () => env().REGISTRATION_ENABLED,
    capability: "settings.manageSecurity",
  },
  "registration.inviteOnly": { schema: z.boolean(), default: () => false, capability: "settings.manageSecurity" },
  "profiles.maxPerUser": {
    schema: z.number().int().min(1).max(100),
    default: () => env().MAX_PROFILES_PER_USER,
    capability: "settings.manage",
  },
  "site.name": { schema: z.string().min(1).max(60), default: () => "COVALink", capability: "settings.manage" },
  // Per-user media limits. The hard upload ceilings (5 MiB, 8192 px,
  // 40 MP, one frame) are code constants and can't be raised here.
  "media.quotaMb": {
    schema: z.number().int().min(1).max(10240),
    default: () => env().MEDIA_QUOTA_MB,
    capability: "settings.manage",
  },
  "media.uploadsPerHour": {
    schema: z.number().int().min(1).max(1000),
    default: () => env().MEDIA_UPLOADS_PER_HOUR,
    capability: "settings.manage",
  },
  "analytics.retentionDays": {
    schema: z.number().int().min(1).max(3650),
    default: () => env().ANALYTICS_RETENTION_DAYS,
    capability: "settings.manage",
  },
} as const satisfies Record<string, { schema: z.ZodType; default: () => unknown; capability: Capability }>;

export type SettingKey = keyof typeof SETTINGS;

export function isSettingKey(key: unknown): key is SettingKey {
  return typeof key === "string" && Object.hasOwn(SETTINGS, key);
}

export function settingCapability(key: SettingKey): Capability {
  return SETTINGS[key].capability;
}
export type SettingValue<K extends SettingKey> = z.output<(typeof SETTINGS)[K]["schema"]>;

export async function getSetting<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
  const def = SETTINGS[key];
  const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, key) });
  if (row) {
    const parsed = def.schema.safeParse(row.value);
    if (parsed.success) return parsed.data as SettingValue<K>;
  }
  return def.default() as SettingValue<K>;
}

/**
 * Advisory-lock class reserved for setting writes (two-int form: class, then
 * `hashtext(key)`). Other classes: 727_001 migrations, 727_002 bootstrap and
 * analytics ingest, 727_003 analytics purge.
 */
const SETTING_LOCK_CLASS = 727_004;

/**
 * The only write path for global settings, and the authorization boundary any
 * future route or action must call. The caller supplies only the actor's id:
 * the actor's role and ban state are re-read from PostgreSQL inside the
 * transaction (row locked FOR SHARE, so a concurrent demotion or ban waits),
 * the key's required capability is checked, and the change is audit-logged
 * in the same transaction. Arguments are typed for callers but re-validated
 * at runtime because this is a trust boundary.
 *
 * Writes of one key are serialized by a transaction-scoped advisory lock
 * taken before the current value is read. A row lock alone can't do
 * this: before the first save there is no row to lock, so concurrent first
 * writes would all compare against the default and each audit a change.
 */
export async function setSetting<K extends SettingKey>(key: K, value: SettingValue<K>, actorId: string): Promise<{ changed: boolean }> {
  if (!isSettingKey(key)) throw new AppError("Unknown setting", "VALIDATION");
  if (typeof actorId !== "string" || actorId.length === 0) throw new AppError("You don't have permission to do that.", "FORBIDDEN");
  const def = SETTINGS[key];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw new AppError("Invalid value for this setting", "VALIDATION");
  const next = parsed.data;

  return db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: users.role, banned: users.banned })
      .from(users)
      .where(eq(users.id, actorId))
      .for("share");
    if (!actor || actor.banned || !isRole(actor.role) || !can(actor.role, def.capability)) {
      throw new AppError("You don't have permission to do that.", "FORBIDDEN");
    }
    // Held until commit or rollback. Under READ COMMITTED the read below starts
    // after the lock is granted, so it sees the previous holder's committed write.
    await tx.execute(sql`select pg_advisory_xact_lock(${SETTING_LOCK_CLASS}::int, hashtext(${key}::text))`);
    const [previous] = await tx
      .select({ value: systemSettings.value })
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .for("update");
    // No-op: the effective value (stored when valid, else the
    // default) already equals the new one. Nothing is written or audited, so
    // a default isn't silently pinned either.
    const stored = previous ? def.schema.safeParse(previous.value) : null;
    const current = stored?.success ? stored.data : def.default();
    if (current === next) return { changed: false };
    await tx
      .insert(systemSettings)
      .values({ key, value: next, updatedBy: actorId })
      .onConflictDoUpdate({ target: systemSettings.key, set: { value: next, updatedBy: actorId } });
    await tx.insert(auditLogs).values({
      actorId,
      action: "settings.update",
      targetType: "setting",
      targetId: key,
      metadata: { from: previous?.value ?? null, to: next },
    });
    return { changed: true };
  });
}

export interface AdminSetting {
  key: SettingKey;
  value: SettingValue<SettingKey>;
  /** `stored` when a valid value is saved, else the environment-derived default. */
  source: "stored" | "default";
  /** Whether this actor may change it (security settings: super administrator only). */
  editable: boolean;
}

/**
 * Settings for the admin console. Read policy: `settings.manage` reads
 * every setting, including the registration (security) settings, which are
 * read-only unless the actor also has `settings.manageSecurity`. The actor is
 * re-read from the database; nothing is cached.
 */
export async function getAdminSettings(actorId: string): Promise<AdminSetting[]> {
  if (typeof actorId !== "string" || actorId.length === 0) throw new AppError("You don't have permission to do that.", "FORBIDDEN");
  const [actor] = await db.select({ role: users.role, banned: users.banned }).from(users).where(eq(users.id, actorId)).limit(1);
  if (!actor || actor.banned || !isRole(actor.role) || !can(actor.role, "settings.manage")) {
    throw new AppError("You don't have permission to do that.", "FORBIDDEN");
  }
  const role = actor.role;
  const rows = await db.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings);
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  return (Object.keys(SETTINGS) as SettingKey[]).map((key) => {
    const def = SETTINGS[key];
    const parsed = stored.has(key) ? def.schema.safeParse(stored.get(key)) : null;
    return {
      key,
      value: (parsed?.success ? parsed.data : def.default()) as SettingValue<SettingKey>,
      source: parsed?.success ? "stored" : "default",
      editable: can(role, def.capability),
    };
  });
}
