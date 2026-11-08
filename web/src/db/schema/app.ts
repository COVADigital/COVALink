import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ProfileDocument } from "@/features/profiles/document";
import { users } from "./auth";

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true })
  .notNull()
  .defaultNow()
  .$onUpdate(() => new Date());

/**
 * A public page. One user may own several. Visual content lives in two JSONB
 * snapshots validated by `profileDocumentSchema`: `draft` (what the editor
 * changes) and `published` (what visitors see).
 */
export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    handle: text("handle").notNull().unique(),
    label: text("label").notNull(),
    isPublished: boolean("is_published").notNull().default(false),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    verified: boolean("verified").notNull().default(false),
    draft: jsonb("draft").$type<ProfileDocument>().notNull(),
    published: jsonb("published").$type<ProfileDocument>(),
    // Optimistic concurrency: every draft write increments draftRevision and
    // must name the revision it was based on. publishedRevision records which
    // draft revision the published snapshot came from.
    draftRevision: integer("draft_revision").notNull().default(0),
    publishedRevision: integer("published_revision"),
    draftUpdatedAt: timestamp("draft_updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt,
    updatedAt,
  },
  (t) => [
    index("profiles_owner_id_idx").on(t.ownerId),
    check("profiles_handle_format", sql`${t.handle} ~ '^[a-z0-9][a-z0-9_-]{1,29}$'`),
    check(
      "profiles_published_consistency",
      sql`(${t.publishedRevision} is null and ${t.published} is null and ${t.isPublished} = false) or (${t.publishedRevision} is not null and ${t.published} is not null and ${t.publishedRevision} <= ${t.draftRevision})`,
    ),
  ],
);

/** Reserved for per-profile custom domains (not used by the MVP). */
export const profileDomains = pgTable("profile_domains", {
  id: uuid("id").primaryKey().defaultRandom(),
  profileId: uuid("profile_id")
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  hostname: text("hostname").notNull().unique(),
  verificationToken: text("verification_token").notNull(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt,
});

/**
 * Uploaded images. Every row is a re-encoded WebP stored
 * at the server-generated `storage_key`; the file is served only while the
 * row exists. Dimensions are the stored output's, within the kind's box.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["avatar", "background"] }).notNull(),
    storageKey: text("storage_key").notNull().unique(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    originalName: text("original_name"),
    createdAt,
  },
  (t) => [
    index("media_assets_owner_kind_created_idx").on(t.ownerId, t.kind, t.createdAt),
    check("media_assets_kind_valid", sql`${t.kind} in ('avatar', 'background')`),
    check("media_assets_mime_webp", sql`${t.mimeType} = 'image/webp'`),
    check("media_assets_size_range", sql`${t.sizeBytes} between 1 and 16777216`),
    check(
      "media_assets_dimensions",
      sql`${t.width} >= 1 and ${t.height} >= 1 and ((${t.kind} = 'avatar' and ${t.width} <= 512 and ${t.height} <= 512) or (${t.kind} = 'background' and ${t.width} <= 2048 and ${t.height} <= 2048))`,
    ),
    check(
      "media_assets_storage_key_format",
      sql`${t.storageKey} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$'`,
    ),
    check("media_assets_original_name_length", sql`${t.originalName} is null or char_length(${t.originalName}) between 1 and 100`),
  ],
);

/**
 * Durable per-user upload-attempt counter: one row per user per fixed
 * hourly window, incremented before an upload body is read. Independent of
 * `media_assets`, so deleting uploads never frees attempts.
 */
export const mediaUploadAttempts = pgTable(
  "media_upload_attempts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.windowStart] }),
    check("media_upload_attempts_positive", sql`${t.attempts} >= 1`),
  ],
);

/**
 * Accepted profile views and link clicks. No IP address,
 * user agent or full referrer URL is ever stored. `visitor_hash` is a
 * pseudonymous daily identifier, present only when a trusted client address
 * was available (TRUST_PROXY=true behind a verified proxy).
 */
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["view", "click"] }).notNull(),
    // Not a foreign key: blocks live inside the profile document.
    blockId: uuid("block_id"),
    visitorHash: text("visitor_hash"),
    referrerHost: text("referrer_host"),
    device: text("device", { enum: ["mobile", "tablet", "desktop", "unknown"] }).notNull(),
    source: text("source"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("analytics_events_profile_time_idx").on(t.profileId, t.occurredAt),
    index("analytics_events_profile_type_time_idx").on(t.profileId, t.type, t.occurredAt),
    index("analytics_events_time_idx").on(t.occurredAt),
    // Repeat-view suppression and the per-visitor ingestion limit.
    index("analytics_events_visitor_idx")
      .on(t.profileId, t.type, t.visitorHash, t.occurredAt)
      .where(sql`${t.visitorHash} is not null`),
    check("analytics_events_type_valid", sql`${t.type} in ('view', 'click')`),
    check("analytics_events_device_valid", sql`${t.device} in ('mobile', 'tablet', 'desktop', 'unknown')`),
    check(
      "analytics_events_block_by_type",
      sql`(${t.type} = 'view' and ${t.blockId} is null) or (${t.type} = 'click' and ${t.blockId} is not null)`,
    ),
    check("analytics_events_visitor_hash_format", sql`${t.visitorHash} is null or ${t.visitorHash} ~ '^[0-9a-f]{64}$'`),
    check("analytics_events_source_format", sql`${t.source} is null or ${t.source} ~ '^[a-z0-9_-]{1,32}$'`),
    check(
      "analytics_events_referrer_host_format",
      sql`${t.referrerHost} is null or (char_length(${t.referrerHost}) <= 253 and ${t.referrerHost} ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$')`,
    ),
  ],
);

/**
 * Random per-UTC-day salts for visitor hashing: 32 random
 * bytes, base64url. `npm run analytics:purge` deletes every salt older than
 * yesterday, after which that day's hashes can't be recomputed.
 */
export const analyticsSalts = pgTable(
  "analytics_salts",
  {
    day: date("day").primaryKey(),
    salt: text("salt").notNull(),
  },
  (t) => [check("analytics_salts_salt_format", sql`${t.salt} ~ '^[A-Za-z0-9_-]{43}$'`)],
);

export const invitations = pgTable("invitations", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt,
});

export const systemSettings = pgTable("system_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt,
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt,
  },
  (t) => [index("audit_logs_created_at_idx").on(t.createdAt), index("audit_logs_actor_idx").on(t.actorId)],
);
