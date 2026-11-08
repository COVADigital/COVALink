-- Analytics events become writable. visitor_hash is NULL
-- when no trusted client address exists; database checks enforce the event
-- vocabulary, the view/click block rule and bounded formats; a partial index
-- serves repeat-view suppression and the per-visitor ingestion limit.
-- Expand-only: no column is dropped or renamed, and no released image before
-- analytics reads or writes these tables, so the previous image runs unchanged
-- on this schema. No released version wrote
-- analytics rows; if a hand-inserted row violates a new check, ADD CONSTRAINT
-- fails and the whole migration rolls back with nothing changed.
ALTER TABLE "analytics_events" ALTER COLUMN "visitor_hash" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "analytics_events_visitor_idx" ON "analytics_events" USING btree ("profile_id","type","visitor_hash","occurred_at") WHERE "analytics_events"."visitor_hash" is not null;--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_type_valid" CHECK ("analytics_events"."type" in ('view', 'click'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_device_valid" CHECK ("analytics_events"."device" in ('mobile', 'tablet', 'desktop', 'unknown'));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_block_by_type" CHECK (("analytics_events"."type" = 'view' and "analytics_events"."block_id" is null) or ("analytics_events"."type" = 'click' and "analytics_events"."block_id" is not null));--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_visitor_hash_format" CHECK ("analytics_events"."visitor_hash" is null or "analytics_events"."visitor_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_source_format" CHECK ("analytics_events"."source" is null or "analytics_events"."source" ~ '^[a-z0-9_-]{1,32}$');--> statement-breakpoint
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_referrer_host_format" CHECK ("analytics_events"."referrer_host" is null or (char_length("analytics_events"."referrer_host") <= 253 and "analytics_events"."referrer_host" ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'));--> statement-breakpoint
ALTER TABLE "analytics_salts" ADD CONSTRAINT "analytics_salts_salt_format" CHECK ("analytics_salts"."salt" ~ '^[A-Za-z0-9_-]{43}$');