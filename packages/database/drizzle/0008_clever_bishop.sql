CREATE TABLE "ai_audit_entries" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"project_id" varchar(64) NOT NULL,
	"user_id" uuid,
	"action" varchar(40) NOT NULL,
	"resource" varchar(200) NOT NULL,
	"result" varchar(10) NOT NULL,
	"detail" varchar(500) DEFAULT '' NOT NULL,
	"prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_plans" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"project_id" varchar(64) NOT NULL,
	"user_id" uuid,
	"prompt" varchar(2000) DEFAULT '' NOT NULL,
	"provider" varchar(80) DEFAULT '' NOT NULL,
	"model" varchar(200) DEFAULT '' NOT NULL,
	"plan" jsonb NOT NULL,
	"validation" jsonb NOT NULL,
	"changes" jsonb NOT NULL,
	"estimate" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"confirmations" jsonb NOT NULL,
	"applied_steps" jsonb NOT NULL,
	"error" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_counters" (
	"project_id" varchar(64) PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"requests" integer DEFAULT 0 NOT NULL,
	"plans_generated" integer DEFAULT 0 NOT NULL,
	"plans_applied" integer DEFAULT 0 NOT NULL,
	"plans_failed" integer DEFAULT 0 NOT NULL,
	"prompt_tokens" bigint DEFAULT 0 NOT NULL,
	"completion_tokens" bigint DEFAULT 0 NOT NULL,
	"tokens_reported" boolean DEFAULT false NOT NULL,
	"total_latency_ms" bigint DEFAULT 0 NOT NULL,
	"last_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_audit_entries" ADD CONSTRAINT "ai_audit_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_counters" ADD CONSTRAINT "ai_usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_audit_entries_project_idx" ON "ai_audit_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_audit_entries_created_idx" ON "ai_audit_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_plans_project_idx" ON "ai_plans" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ai_plans_status_idx" ON "ai_plans" USING btree ("status");