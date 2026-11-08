CREATE TABLE "system_bootstrap" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"super_admin_id" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_bootstrap_singleton" CHECK ("system_bootstrap"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "system_bootstrap" ADD CONSTRAINT "system_bootstrap_super_admin_id_users_id_fk" FOREIGN KEY ("super_admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_super_admin" ON "users" USING btree ("role") WHERE "users"."role" = 'super_admin';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("users"."role" in ('super_admin', 'admin', 'user'));