CREATE TYPE "public"."observabilityBackendKind" AS ENUM('prometheus', 'loki', 'tempo', 'clickhouse', 'otlp');--> statement-breakpoint
CREATE TYPE "public"."observabilityBackendStatus" AS ENUM('provisioning', 'active', 'error', 'offline');--> statement-breakpoint
CREATE TYPE "public"."observabilityQueryKind" AS ENUM('metrics', 'logs', 'traces');--> statement-breakpoint
CREATE TYPE "public"."observabilityQueryStatus" AS ENUM('succeeded', 'failed', 'denied');--> statement-breakpoint
CREATE TYPE "public"."stripeUsageDeliveryStatus" AS ENUM('pending', 'delivering', 'delivered', 'failed');--> statement-breakpoint
ALTER TYPE "public"."usageMetric" ADD VALUE 'database_byte_seconds';--> statement-breakpoint
ALTER TYPE "public"."usageSource" ADD VALUE 'database' BEFORE 'manual';--> statement-breakpoint
CREATE TABLE "managed_data_usage_checkpoint" (
	"managed_data_resource_id" text PRIMARY KEY NOT NULL,
	"last_metered_at" timestamp NOT NULL,
	"last_sample_at" timestamp NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observability_query_audit" (
	"observability_query_audit_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"application_id" text,
	"deployment_id" text,
	"kind" "observabilityQueryKind" NOT NULL,
	"status" "observabilityQueryStatus" NOT NULL,
	"query_fingerprint" text NOT NULL,
	"result_count" integer,
	"error_message" text,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_observability_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"metrics_retention_days" integer DEFAULT 30 NOT NULL,
	"logs_retention_days" integer DEFAULT 7 NOT NULL,
	"traces_retention_days" integer DEFAULT 7 NOT NULL,
	"query_enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_observability_backend" (
	"observability_backend_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "observabilityBackendKind" NOT NULL,
	"status" "observabilityBackendStatus" DEFAULT 'provisioning' NOT NULL,
	"endpoint" text NOT NULL,
	"auth_token" text,
	"tenant_header" text DEFAULT 'X-Scope-OrgID' NOT NULL,
	"tenant_id" text DEFAULT 'vlyv' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_usage_checkpoint" (
	"placement_id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"last_metered_at" timestamp NOT NULL,
	"last_sample_at" timestamp NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_usage_delivery" (
	"stripe_usage_delivery_id" text PRIMARY KEY NOT NULL,
	"stripe_usage_meter_id" text NOT NULL,
	"usage_event_id" text NOT NULL,
	"identifier" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_event_name" text NOT NULL,
	"quantity" bigint NOT NULL,
	"event_timestamp" timestamp NOT NULL,
	"status" "stripeUsageDeliveryStatus" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stripe_usage_meter" (
	"stripe_usage_meter_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric" "usageMetric" NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_event_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_static_asset_publication" ADD COLUMN "last_metered_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_usage_checkpoint" ADD CONSTRAINT "managed_data_usage_checkpoint_managed_data_resource_id_managed_data_resource_managed_data_resource_id_fk" FOREIGN KEY ("managed_data_resource_id") REFERENCES "public"."managed_data_resource"("managed_data_resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observability_query_audit" ADD CONSTRAINT "observability_query_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observability_query_audit" ADD CONSTRAINT "observability_query_audit_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observability_query_audit" ADD CONSTRAINT "observability_query_audit_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observability_query_audit" ADD CONSTRAINT "observability_query_audit_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_observability_policy" ADD CONSTRAINT "organization_observability_policy_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_usage_checkpoint" ADD CONSTRAINT "runtime_usage_checkpoint_placement_id_platform_placement_placement_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."platform_placement"("placement_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_usage_checkpoint" ADD CONSTRAINT "runtime_usage_checkpoint_cluster_id_platform_cluster_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."platform_cluster"("cluster_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_usage_delivery" ADD CONSTRAINT "stripe_usage_delivery_stripe_usage_meter_id_stripe_usage_meter_stripe_usage_meter_id_fk" FOREIGN KEY ("stripe_usage_meter_id") REFERENCES "public"."stripe_usage_meter"("stripe_usage_meter_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_usage_delivery" ADD CONSTRAINT "stripe_usage_delivery_usage_event_id_usage_event_usage_event_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_event"("usage_event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_usage_meter" ADD CONSTRAINT "stripe_usage_meter_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managedDataUsageCheckpoint_sample_idx" ON "managed_data_usage_checkpoint" USING btree ("last_sample_at");--> statement-breakpoint
CREATE INDEX "observabilityQueryAudit_organizationCreated_idx" ON "observability_query_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "organizationObservabilityPolicy_query_idx" ON "organization_observability_policy" USING btree ("query_enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "platformObservabilityBackend_name_unique" ON "platform_observability_backend" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "platformObservabilityBackend_kindDefault_unique" ON "platform_observability_backend" USING btree ("kind","is_default") WHERE "platform_observability_backend"."is_default" = true;--> statement-breakpoint
CREATE INDEX "platformObservabilityBackend_kindStatus_idx" ON "platform_observability_backend" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "runtimeUsageCheckpoint_cluster_idx" ON "runtime_usage_checkpoint" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripeUsageDelivery_meterEvent_unique" ON "stripe_usage_delivery" USING btree ("stripe_usage_meter_id","usage_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripeUsageDelivery_identifier_unique" ON "stripe_usage_delivery" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "stripeUsageDelivery_statusRetry_idx" ON "stripe_usage_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "stripeUsageMeter_organizationMetric_unique" ON "stripe_usage_meter" USING btree ("organization_id","metric");--> statement-breakpoint
CREATE INDEX "stripeUsageMeter_enabled_idx" ON "stripe_usage_meter" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "platformStaticAssetPublication_metering_idx" ON "platform_static_asset_publication" USING btree ("status","last_metered_at");