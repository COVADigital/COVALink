-- Subscribe-block sign-ups. One row per (profile, email): pending until the
-- visitor opens the emailed confirm link, then confirmed. Only SHA-256 hashes
-- of the confirm and remove tokens are stored; checks keep the status, token
-- and confirmation time consistent. Rows cascade with their profile.
-- Expand-only: a new table that no earlier image reads or writes, so the
-- previous image runs unchanged on this schema.
CREATE TABLE "audience_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" text NOT NULL,
	"consent_text" text NOT NULL,
	"block_id" uuid NOT NULL,
	"confirm_token_hash" text,
	"remove_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "audience_contacts_confirm_token_hash_unique" UNIQUE("confirm_token_hash"),
	CONSTRAINT "audience_contacts_remove_token_hash_unique" UNIQUE("remove_token_hash"),
	CONSTRAINT "audience_contacts_profile_email_key" UNIQUE("profile_id","email"),
	CONSTRAINT "audience_contacts_status_valid" CHECK ("audience_contacts"."status" in ('pending', 'confirmed')),
	CONSTRAINT "audience_contacts_email_format" CHECK (char_length("audience_contacts"."email") <= 254 and "audience_contacts"."email" = lower("audience_contacts"."email")),
	CONSTRAINT "audience_contacts_status_consistency" CHECK (("audience_contacts"."status" = 'pending' and "audience_contacts"."confirm_token_hash" is not null and "audience_contacts"."confirmed_at" is null) or ("audience_contacts"."status" = 'confirmed' and "audience_contacts"."confirm_token_hash" is null and "audience_contacts"."confirmed_at" is not null)),
	CONSTRAINT "audience_contacts_token_format" CHECK ("audience_contacts"."remove_token_hash" ~ '^[0-9a-f]{64}$' and ("audience_contacts"."confirm_token_hash" is null or "audience_contacts"."confirm_token_hash" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD CONSTRAINT "audience_contacts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audience_contacts_profile_status_idx" ON "audience_contacts" USING btree ("profile_id","status","created_at");