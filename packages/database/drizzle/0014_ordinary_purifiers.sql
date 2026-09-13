CREATE TABLE "storage_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"bucket" varchar(200) NOT NULL,
	"path" varchar(1024) NOT NULL,
	"content_type" varchar(200),
	"total_bytes" bigint,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"upsert" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_upload_sessions" ADD CONSTRAINT "storage_upload_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_upload_sessions" ADD CONSTRAINT "storage_upload_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_upload_sessions_project_idx" ON "storage_upload_sessions" USING btree ("project_id");