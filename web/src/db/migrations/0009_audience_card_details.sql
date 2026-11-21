ALTER TABLE "audience_contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD CONSTRAINT "audience_contacts_phone_format" CHECK ("audience_contacts"."phone" is null or "audience_contacts"."phone" ~ '^[+]?[0-9]{4,15}$');--> statement-breakpoint
ALTER TABLE "audience_contacts" ADD CONSTRAINT "audience_contacts_note_length" CHECK ("audience_contacts"."note" is null or char_length("audience_contacts"."note") between 1 and 500);