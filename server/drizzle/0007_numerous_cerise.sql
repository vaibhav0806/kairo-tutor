CREATE TABLE "access_invite" (
	"email" text PRIMARY KEY NOT NULL,
	"note" text,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"redeemed_at" timestamp with time zone
);
--> statement-breakpoint
-- Invites are matched case-insensitively (Google returns whatever casing the user typed), so the
-- stored form must be lowercase or an invite would silently miss.
ALTER TABLE "access_invite" ADD CONSTRAINT "access_invite_email_lowercase" CHECK ("email" = lower("email"));--> statement-breakpoint
ALTER TABLE "access_invite" ADD CONSTRAINT "access_invite_email_length" CHECK (char_length("email") BETWEEN 3 AND 254);
