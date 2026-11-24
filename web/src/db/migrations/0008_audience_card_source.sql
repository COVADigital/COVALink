ALTER TABLE "audience_contacts" ALTER COLUMN "block_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD COLUMN "source" text DEFAULT 'block' NOT NULL;--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD CONSTRAINT "audience_contacts_source_valid" CHECK (("audience_contacts"."source" = 'block' and "audience_contacts"."block_id" is not null) or ("audience_contacts"."source" = 'card' and "audience_contacts"."block_id" is null));--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD CONSTRAINT "audience_contacts_name_length" CHECK ("audience_contacts"."name" is null or char_length("audience_contacts"."name") between 1 and 100);