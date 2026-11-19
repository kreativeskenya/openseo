ALTER TABLE "user_settings" ADD COLUMN "gemini_key_enc" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "gemini_key_hint" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "gemini_key_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "gemini_models" text[];