CREATE TABLE "platform_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"actor_email" varchar(320) NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" varchar(300) NOT NULL,
	"body_html" text,
	"body_text" text,
	"template" varchar(60),
	"status" varchar(20) NOT NULL,
	"provider" varchar(30),
	"provider_id" varchar(200),
	"error" text,
	"is_test" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_reason" varchar(300);--> statement-breakpoint
ALTER TABLE "platform_emails" ADD CONSTRAINT "platform_emails_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_emails_created_idx" ON "platform_emails" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "platform_emails_status_idx" ON "platform_emails" USING btree ("status");--> statement-breakpoint
CREATE INDEX "platform_emails_actor_idx" ON "platform_emails" USING btree ("actor_user_id");