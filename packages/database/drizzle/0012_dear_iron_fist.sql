CREATE TABLE "billing_budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"limit_cents" integer NOT NULL,
	"action" varchar(10) DEFAULT 'alert' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_budgets" ADD CONSTRAINT "billing_budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_budgets_org_idx" ON "billing_budgets" USING btree ("organization_id");