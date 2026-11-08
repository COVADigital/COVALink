ALTER TABLE "profiles" ADD COLUMN "draft_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "published_revision" integer;--> statement-breakpoint
UPDATE "profiles"
SET
	"draft_revision" = CASE
		WHEN "published" IS NOT NULL AND "published_at" IS NOT NULL AND "draft_updated_at" > "published_at" THEN 1
		ELSE 0
	END,
	"published_revision" = CASE WHEN "published" IS NOT NULL THEN 0 ELSE NULL END,
	"is_published" = CASE WHEN "published" IS NULL THEN false ELSE "is_published" END;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_published_consistency" CHECK (("profiles"."published_revision" is null and "profiles"."published" is null and "profiles"."is_published" = false) or ("profiles"."published_revision" is not null and "profiles"."published" is not null and "profiles"."published_revision" <= "profiles"."draft_revision"));
