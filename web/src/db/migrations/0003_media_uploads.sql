-- media_assets gains a required kind and required output dimensions.
-- No released COVALink version created media_assets rows, and a pre-existing
-- row's kind can't be inferred safely, so existing rows are not guessed at:
-- the migration refuses to run (drizzle applies pending migrations in one
-- transaction, so nothing is changed) until an operator has backed them up
-- and removed them.
LOCK TABLE "media_assets" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "media_assets") THEN
		RAISE EXCEPTION 'covalink migration 0003_media_uploads: media_assets contains % pre-existing row(s) that this migration cannot classify. Back them up, remove them, then rerun the migration. No changes were made.', (SELECT count(*) FROM "media_assets");
	END IF;
END $$;--> statement-breakpoint
CREATE TABLE "media_upload_attempts" (
	"user_id" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	CONSTRAINT "media_upload_attempts_user_id_window_start_pk" PRIMARY KEY("user_id","window_start"),
	CONSTRAINT "media_upload_attempts_positive" CHECK ("media_upload_attempts"."attempts" >= 1)
);
--> statement-breakpoint
DROP INDEX "media_assets_owner_id_idx";--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "width" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "height" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "media_upload_attempts" ADD CONSTRAINT "media_upload_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_owner_kind_created_idx" ON "media_assets" USING btree ("owner_id","kind","created_at");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_kind_valid" CHECK ("media_assets"."kind" in ('avatar', 'background'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_mime_webp" CHECK ("media_assets"."mime_type" = 'image/webp');--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_size_range" CHECK ("media_assets"."size_bytes" between 1 and 16777216);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_dimensions" CHECK ("media_assets"."width" >= 1 and "media_assets"."height" >= 1 and (("media_assets"."kind" = 'avatar' and "media_assets"."width" <= 512 and "media_assets"."height" <= 512) or ("media_assets"."kind" = 'background' and "media_assets"."width" <= 2048 and "media_assets"."height" <= 2048)));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_storage_key_format" CHECK ("media_assets"."storage_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$');--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_original_name_length" CHECK ("media_assets"."original_name" is null or char_length("media_assets"."original_name") between 1 and 100);
