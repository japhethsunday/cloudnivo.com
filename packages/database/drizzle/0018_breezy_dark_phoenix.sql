CREATE TABLE "project_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" varchar(120) NOT NULL,
	"environment" varchar(40) DEFAULT 'development' NOT NULL,
	"target" varchar(100) DEFAULT 'main' NOT NULL,
	"statements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"destructive" boolean DEFAULT false NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_by" uuid,
	"applied_by_token_id" varchar(100),
	"applied_at" timestamp with time zone,
	"schema_after" varchar(64),
	"error" varchar(500),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_migrations_project_version_unique" UNIQUE("project_id","version")
);
--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_migrations_project_idx" ON "project_migrations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_migrations_status_idx" ON "project_migrations" USING btree ("status");