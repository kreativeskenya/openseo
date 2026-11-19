CREATE TABLE "content_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"product_id" uuid,
	"product_name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"keyword" text,
	"content" jsonb NOT NULL,
	"input" jsonb NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_store_id_content_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."content_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_drafts" ADD CONSTRAINT "content_drafts_product_id_content_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."content_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_drafts_store_idx" ON "content_drafts" USING btree ("store_id");--> statement-breakpoint
CREATE INDEX "content_drafts_project_idx" ON "content_drafts" USING btree ("project_id");