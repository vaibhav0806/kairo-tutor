CREATE TABLE "rate_counter" (
	"bucket" text PRIMARY KEY NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_counter_expires_idx" ON "rate_counter" USING btree ("expires_at");