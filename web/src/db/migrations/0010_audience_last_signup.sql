DROP INDEX "audience_contacts_pending_created_idx";--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD COLUMN "last_signup_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD COLUMN "last_source" text DEFAULT 'block' NOT NULL;--> statement-breakpoint
UPDATE "audience_contacts" SET "last_signup_at" = "created_at", "last_source" = "source";--> statement-breakpoint
CREATE INDEX "audience_contacts_pending_last_signup_idx" ON "audience_contacts" USING btree ("last_signup_at") WHERE "audience_contacts"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD CONSTRAINT "audience_contacts_last_source_valid" CHECK ("audience_contacts"."last_source" in ('block', 'card'));