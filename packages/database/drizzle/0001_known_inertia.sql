CREATE TABLE "storage_buckets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"visibility" varchar(10) DEFAULT 'private' NOT NULL,
	"file_size_limit" integer,
	"allowed_mime_types" text[] DEFAULT '{}' NOT NULL,
	"owner_isolation" varchar(5) DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_buckets_project_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"bucket_id" uuid NOT NULL,
	"bucket" varchar(63) NOT NULL,
	"path" varchar(1024) NOT NULL,
	"filename" varchar(255) NOT NULL,
	"mime_type" varchar(127) NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"etag" varchar(64) DEFAULT '' NOT NULL,
	"storage_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_objects_bucket_path_unique" UNIQUE("bucket_id","path")
);
--> statement-breakpoint
ALTER TABLE "storage_buckets" ADD CONSTRAINT "storage_buckets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_buckets" ADD CONSTRAINT "storage_buckets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_objects" ADD CONSTRAINT "storage_objects_bucket_id_storage_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."storage_buckets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "storage_buckets_org_idx" ON "storage_buckets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "storage_objects_project_idx" ON "storage_objects" USING btree ("project_id");