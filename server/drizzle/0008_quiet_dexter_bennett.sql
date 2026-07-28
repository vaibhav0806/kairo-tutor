CREATE TABLE "download_request" (
	"email" text PRIMARY KEY NOT NULL,
	"invited" boolean DEFAULT false NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL
);
