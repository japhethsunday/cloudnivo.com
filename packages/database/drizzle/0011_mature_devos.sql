CREATE TABLE "project_branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(40) NOT NULL,
	"database_id" varchar(200) DEFAULT '' NOT NULL,
	"db_name" varchar(63) DEFAULT '' NOT NULL,
	"db_user" varchar(63) DEFAULT '' NOT NULL,
	"db_password" text,
	"host" varchar(255) DEFAULT '' NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"source" varchar(100) DEFAULT 'main' NOT NULL,
	"status" varchar(20) DEFAULT 'creating' NOT NULL,
	"last_error" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_branches_project_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "project_secrets" (
	"project_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"ciphertext" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_secrets_project_name_unique" UNIQUE("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "is_preview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "project_environments" ADD COLUMN "status" varchar(20) DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_branches" ADD CONSTRAINT "project_branches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_branches_project_idx" ON "project_branches" USING btree ("project_id");