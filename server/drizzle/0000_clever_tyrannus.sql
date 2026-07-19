CREATE TYPE "public"."plan_t" AS ENUM('free', 'pro');--> statement-breakpoint
CREATE TYPE "public"."sub_status_t" AS ENUM('none', 'pending', 'active', 'on_hold', 'cancelled', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "oauth_code" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" "sub_status_t" DEFAULT 'none' NOT NULL,
	"dodo_subscription_id" text,
	"dodo_customer_id" text,
	"dodo_product_id" text,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_dodo_subscription_id_unique" UNIQUE("dodo_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "usage_counter" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan" "plan_t" DEFAULT 'free' NOT NULL,
	"used_free" integer DEFAULT 0 NOT NULL,
	"free_limit" integer DEFAULT 10 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"ask_id" uuid PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"counted" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_event" (
	"webhook_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
