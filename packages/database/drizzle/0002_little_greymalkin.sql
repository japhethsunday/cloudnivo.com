CREATE TABLE "function_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"function_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"key" varchar(64) NOT NULL,
	"value" text NOT NULL,
	"secret" varchar(5) DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "function_env_fn_key_unique" UNIQUE("function_id","key")
);
--> statement-breakpoint
CREATE TABLE "function_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"function_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"source_bytes" integer DEFAULT 0 NOT NULL,
	"source" text NOT NULL,
	"runtime" varchar(20) DEFAULT 'node22' NOT NULL,
	"entrypoint" varchar(128) DEFAULT 'handler' NOT NULL,
	"active" varchar(5) DEFAULT 'false' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "function_versions_fn_version_unique" UNIQUE("function_id","version")
);
--> statement-breakpoint
CREATE TABLE "functions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"slug" varchar(63) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"runtime" varchar(20) DEFAULT 'node22' NOT NULL,
	"entrypoint" varchar(128) DEFAULT 'handler' NOT NULL,
	"status" varchar(20) DEFAULT 'creating' NOT NULL,
	"active_version" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_at" timestamp with time zone,
	CONSTRAINT "functions_project_slug_unique" UNIQUE("project_id","slug")
);
--> statement-breakpoint
ALTER TABLE "function_env_vars" ADD CONSTRAINT "function_env_vars_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "function_env_vars" ADD CONSTRAINT "function_env_vars_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "function_versions" ADD CONSTRAINT "function_versions_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "function_versions" ADD CONSTRAINT "function_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "function_versions" ADD CONSTRAINT "function_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "functions" ADD CONSTRAINT "functions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "functions" ADD CONSTRAINT "functions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "functions" ADD CONSTRAINT "functions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "function_env_fn_idx" ON "function_env_vars" USING btree ("function_id");--> statement-breakpoint
CREATE INDEX "function_versions_fn_idx" ON "function_versions" USING btree ("function_id");--> statement-breakpoint
CREATE INDEX "functions_org_idx" ON "functions" USING btree ("organization_id");