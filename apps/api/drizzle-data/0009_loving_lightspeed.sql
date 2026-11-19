CREATE TABLE "content_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"store_id" uuid,
	"kind" text NOT NULL,
	"statement" text NOT NULL,
	"source" text,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"url" text NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"category" text,
	"description" text DEFAULT '' NOT NULL,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_kes" double precision,
	"sale_price_kes" double precision,
	"warranty" text,
	"price_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "content_facts" ADD CONSTRAINT "content_facts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_facts" ADD CONSTRAINT "content_facts_store_id_content_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."content_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_products" ADD CONSTRAINT "content_products_store_id_content_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."content_stores"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_stores" ADD CONSTRAINT "content_stores_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_facts_project_idx" ON "content_facts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "content_facts_store_idx" ON "content_facts" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_products_store_url_idx" ON "content_products" USING btree ("store_id","url");--> statement-breakpoint
CREATE INDEX "content_products_store_idx" ON "content_products" USING btree ("store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "content_stores_project_domain_idx" ON "content_stores" USING btree ("project_id","domain");