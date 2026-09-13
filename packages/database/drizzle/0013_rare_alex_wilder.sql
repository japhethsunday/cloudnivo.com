CREATE TABLE "custom_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"domain" varchar(255) NOT NULL,
	"purpose" varchar(20) DEFAULT 'api' NOT NULL,
	"verify_token" varchar(100) NOT NULL,
	"verified_at" timestamp with time zone,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_domains_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "log_drains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid,
	"url" varchar(2000) NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_prefix" varchar(20) DEFAULT '' NOT NULL,
	"secret_hash" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_status" varchar(20) DEFAULT 'never' NOT NULL,
	"last_error" varchar(300),
	"cursor" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"severity" varchar(20) DEFAULT 'minor' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_policies" ADD COLUMN "log_retention_days" integer;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_drains" ADD CONSTRAINT "log_drains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "log_drains" ADD CONSTRAINT "log_drains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_domains_org_idx" ON "custom_domains" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "log_drains_org_idx" ON "log_drains" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "status_incidents_status_idx" ON "status_incidents" USING btree ("status");