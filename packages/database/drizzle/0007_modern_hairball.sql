CREATE TABLE "automation_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" varchar(64) NOT NULL,
	"event_type" varchar(40) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" jsonb NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" varchar(64) NOT NULL,
	"body" jsonb NOT NULL,
	"idempotency_key" varchar(128),
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"max_deliveries" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_queues_project_name_ux" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "automation_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"function_slug" varchar(100) NOT NULL,
	"cron" varchar(100) NOT NULL,
	"payload" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_schedules_project_name_ux" UNIQUE("project_id","name")
);
--> statement-breakpoint
CREATE TABLE "automation_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" varchar(64) NOT NULL,
	"name" varchar(64) NOT NULL,
	"url" varchar(2000) NOT NULL,
	"event_types" jsonb NOT NULL,
	"secret_prefix" varchar(16) NOT NULL,
	"secret_hash" varchar(64) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_webhooks_project_name_ux" UNIQUE("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_webhook_id_automation_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."automation_webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_deliveries" ADD CONSTRAINT "automation_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_messages" ADD CONSTRAINT "automation_messages_queue_id_automation_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."automation_queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_messages" ADD CONSTRAINT "automation_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_queues" ADD CONSTRAINT "automation_queues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_schedules" ADD CONSTRAINT "automation_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_webhooks" ADD CONSTRAINT "automation_webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_deliveries_webhook_idx" ON "automation_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "automation_deliveries_status_idx" ON "automation_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_deliveries_next_idx" ON "automation_deliveries" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "automation_messages_queue_idx" ON "automation_messages" USING btree ("queue_id");--> statement-breakpoint
CREATE INDEX "automation_messages_status_idx" ON "automation_messages" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_queues_project_idx" ON "automation_queues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_schedules_project_idx" ON "automation_schedules" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "automation_schedules_next_idx" ON "automation_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "automation_webhooks_project_idx" ON "automation_webhooks" USING btree ("project_id");