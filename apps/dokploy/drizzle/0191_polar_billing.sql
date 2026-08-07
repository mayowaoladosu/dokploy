CREATE TYPE "public"."polarWebhookStatus" AS ENUM('processing', 'processed', 'failed');--> statement-breakpoint
ALTER TYPE "public"."stripeUsageDeliveryStatus" RENAME TO "polarUsageDeliveryStatus";--> statement-breakpoint
CREATE TABLE "polar_webhook_event" (
	"polar_webhook_event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload_timestamp" timestamp NOT NULL,
	"status" "polarWebhookStatus" DEFAULT 'processing' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "user"
		WHERE "stripeCustomerId" IS NOT NULL OR "stripeSubscriptionId" IS NOT NULL
	) THEN
		RAISE EXCEPTION 'Polar migration requires all legacy Stripe customers and subscriptions to be migrated before upgrade';
	END IF;
END $$;--> statement-breakpoint
UPDATE "platform_managed_data_provider"
SET
	"status" = 'offline',
	"default_kinds" = ARRAY[]::"managedDataKind"[],
	"updated_at" = now()
WHERE "type" = 'upstash';--> statement-breakpoint
UPDATE "platform_managed_data_provider"
SET
	"kinds" = ARRAY['postgres']::"managedDataKind"[],
	"default_kinds" = CASE
		WHEN 'postgres' = ANY("default_kinds") THEN ARRAY['postgres']::"managedDataKind"[]
		ELSE ARRAY[]::"managedDataKind"[]
	END,
	"updated_at" = now()
WHERE "type" = 'http';--> statement-breakpoint
ALTER TABLE "stripe_usage_delivery" RENAME TO "polar_usage_delivery";--> statement-breakpoint
ALTER TABLE "stripe_usage_meter" RENAME TO "polar_usage_meter";--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" RENAME COLUMN "stripe_usage_delivery_id" TO "polar_usage_delivery_id";--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" RENAME COLUMN "stripe_usage_meter_id" TO "polar_usage_meter_id";--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" RENAME COLUMN "stripe_customer_id" TO "external_customer_id";--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" RENAME COLUMN "stripe_event_name" TO "polar_event_name";--> statement-breakpoint
ALTER TABLE "polar_usage_meter" RENAME COLUMN "stripe_usage_meter_id" TO "polar_usage_meter_id";--> statement-breakpoint
ALTER TABLE "polar_usage_meter" RENAME COLUMN "stripe_event_name" TO "polar_event_name";--> statement-breakpoint
UPDATE "polar_usage_meter"
SET "polar_event_name" = 'vlyv.' || "metric"::text;--> statement-breakpoint
UPDATE "polar_usage_delivery" AS delivery
SET
	"external_customer_id" = meter."organization_id",
	"polar_event_name" = meter."polar_event_name"
FROM "polar_usage_meter" AS meter
WHERE delivery."polar_usage_meter_id" = meter."polar_usage_meter_id";--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" DROP CONSTRAINT "stripe_usage_delivery_stripe_usage_meter_id_stripe_usage_meter_stripe_usage_meter_id_fk";
--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" DROP CONSTRAINT "stripe_usage_delivery_usage_event_id_usage_event_usage_event_id_fk";
--> statement-breakpoint
ALTER TABLE "polar_usage_meter" DROP CONSTRAINT "stripe_usage_meter_organization_id_organization_id_fk";
--> statement-breakpoint
DROP INDEX "stripeUsageDelivery_meterEvent_unique";--> statement-breakpoint
DROP INDEX "stripeUsageDelivery_identifier_unique";--> statement-breakpoint
DROP INDEX "stripeUsageDelivery_statusRetry_idx";--> statement-breakpoint
DROP INDEX "stripeUsageMeter_organizationMetric_unique";--> statement-breakpoint
DROP INDEX "stripeUsageMeter_enabled_idx";--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "polar_customer_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "polar_subscription_id" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_plan" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_status" text;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_seats" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_current_period_end" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_last_synced_at" timestamp;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "billing_last_event_at" timestamp;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "billing_suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preview_deployments" ADD COLUMN "billing_suspended_replicas" integer;--> statement-breakpoint
CREATE INDEX "polarWebhookEvent_statusUpdated_idx" ON "polar_webhook_event" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" ADD CONSTRAINT "polar_usage_delivery_polar_usage_meter_id_polar_usage_meter_polar_usage_meter_id_fk" FOREIGN KEY ("polar_usage_meter_id") REFERENCES "public"."polar_usage_meter"("polar_usage_meter_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polar_usage_delivery" ADD CONSTRAINT "polar_usage_delivery_usage_event_id_usage_event_usage_event_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_event"("usage_event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polar_usage_meter" ADD CONSTRAINT "polar_usage_meter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "polarUsageDelivery_meterEvent_unique" ON "polar_usage_delivery" USING btree ("polar_usage_meter_id","usage_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "polarUsageDelivery_identifier_unique" ON "polar_usage_delivery" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "polarUsageDelivery_statusRetry_idx" ON "polar_usage_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "polarUsageMeter_organizationMetric_unique" ON "polar_usage_meter" USING btree ("organization_id","metric");--> statement-breakpoint
CREATE INDEX "polarUsageMeter_enabled_idx" ON "polar_usage_meter" USING btree ("enabled");--> statement-breakpoint
ALTER TABLE "polar_usage_meter" DROP COLUMN "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "stripeCustomerId";--> statement-breakpoint
ALTER TABLE "user" DROP COLUMN "stripeSubscriptionId";--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_polar_customer_id_unique" UNIQUE("polar_customer_id");
--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_polar_subscription_id_unique" UNIQUE("polar_subscription_id");--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_billing_plan_check" CHECK ("billing_plan" IS NULL OR "billing_plan" IN ('legacy', 'hobby', 'startup'));--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_billing_status_check" CHECK ("billing_status" IS NULL OR "billing_status" IN ('active', 'trialing', 'past_due', 'canceled', 'paused', 'revoked'));--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_billing_seats_check" CHECK ("billing_seats" >= 0);--> statement-breakpoint
CREATE INDEX "organization_billingStatus_idx" ON "organization" USING btree ("billing_status");--> statement-breakpoint
CREATE INDEX "organization_billingLastSyncedAt_idx" ON "organization" USING btree ("billing_last_synced_at");
--> statement-breakpoint
WITH ranked AS (
	SELECT "region_id", row_number() OVER (ORDER BY "created_at", "region_id") AS position
	FROM "platform_region"
	WHERE "is_default" = true
)
UPDATE "platform_region" AS region
SET "is_default" = false, "updated_at" = now()
FROM ranked
WHERE region."region_id" = ranked."region_id" AND ranked.position > 1;--> statement-breakpoint
WITH ranked AS (
	SELECT "cluster_id", row_number() OVER (ORDER BY "created_at", "cluster_id") AS position
	FROM "platform_cluster"
	WHERE "is_default" = true
)
UPDATE "platform_cluster" AS cluster
SET "is_default" = false, "updated_at" = now()
FROM ranked
WHERE cluster."cluster_id" = ranked."cluster_id" AND ranked.position > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "platformRegion_default_unique" ON "platform_region" USING btree ("is_default") WHERE "is_default" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "platformCluster_default_unique" ON "platform_cluster" USING btree ("is_default") WHERE "is_default" = true;
