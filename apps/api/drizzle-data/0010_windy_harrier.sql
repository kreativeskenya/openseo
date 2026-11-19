DROP INDEX "content_products_store_url_idx";--> statement-breakpoint
ALTER TABLE "content_products" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "content_products" ADD COLUMN "slug" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "content_products_store_slug_idx" ON "content_products" USING btree ("store_id","slug");