// Tables required by Better Auth (core schema, see @better-auth/core db/get-tables).
// Property names are the Better Auth field names; column names are snake_case.
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgTable, smallint, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // Application fields (declared as Better Auth additionalFields with input: false)
    role: text("role", { enum: ["super_admin", "admin", "user"] }).notNull().default("user"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    ...timestamps,
  },
  (t) => [
    check("users_role_valid", sql`${t.role} in ('super_admin', 'admin', 'user')`),
    // Invariant: at most one super administrator can exist.
    uniqueIndex("users_single_super_admin").on(t.role).where(sql`${t.role} = 'super_admin'`),
  ],
);

/**
 * One-time installation bootstrap record. The single allowed row (id = 1) is
 * inserted in the same transaction that creates the super administrator, so
 * "setup complete" can never exist without that account.
 */
export const systemBootstrap = pgTable(
  "system_bootstrap",
  {
    id: smallint("id").primaryKey().default(1),
    superAdminId: text("super_admin_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("system_bootstrap_singleton", sql`${t.id} = 1`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

export const rateLimits = pgTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});
