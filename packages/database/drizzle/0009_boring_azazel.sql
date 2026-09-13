CREATE TABLE "organization_policies" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"allowed_email_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"require_mfa" boolean DEFAULT false NOT NULL,
	"password_min_length" integer,
	"password_min_classes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(40) DEFAULT 'oidc' NOT NULL,
	"display_name" varchar(120) DEFAULT 'SSO' NOT NULL,
	"issuer" varchar(500) NOT NULL,
	"client_id" varchar(500) NOT NULL,
	"client_secret_enc" text NOT NULL,
	"default_role" varchar(20) DEFAULT 'member' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "backup_code_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_policies" ADD CONSTRAINT "organization_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sso_connections_org_idx" ON "sso_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sso_connections_enabled_idx" ON "sso_connections" USING btree ("enabled");