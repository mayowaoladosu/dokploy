CREATE TYPE "public"."domainVerificationMethod" AS ENUM('platform', 'dns_txt');--> statement-breakpoint
CREATE TYPE "public"."domainVerificationStatus" AS ENUM('pending', 'verified', 'failed');--> statement-breakpoint
CREATE TYPE "public"."managedDataKind" AS ENUM('postgres', 'mysql', 'mariadb', 'mongo', 'redis', 'libsql');--> statement-breakpoint
CREATE TYPE "public"."managedDataStatus" AS ENUM('provisioning', 'ready', 'error', 'deleting', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."usageMetric" AS ENUM('build_seconds', 'cpu_milliseconds', 'memory_byte_seconds', 'request_count', 'egress_bytes', 'storage_byte_hours');--> statement-breakpoint
CREATE TYPE "public"."usageQuotaAction" AS ENUM('warn', 'block', 'throttle');--> statement-breakpoint
CREATE TYPE "public"."usageQuotaWindow" AS ENUM('hour', 'day', 'month');--> statement-breakpoint
CREATE TYPE "public"."usageSource" AS ENUM('build', 'runtime', 'edge', 'storage', 'manual');--> statement-breakpoint
CREATE TYPE "public"."platformClusterRuntime" AS ENUM('swarm', 'kubernetes');--> statement-breakpoint
CREATE TYPE "public"."platformClusterStatus" AS ENUM('provisioning', 'active', 'draining', 'error', 'offline');--> statement-breakpoint
CREATE TYPE "public"."platformNodePoolPurpose" AS ENUM('runtime', 'build', 'system');--> statement-breakpoint
CREATE TYPE "public"."platformNodePoolStatus" AS ENUM('active', 'draining', 'offline');--> statement-breakpoint
CREATE TYPE "public"."platformPlacementStatus" AS ENUM('pending', 'active', 'draining', 'failed');--> statement-breakpoint
CREATE TYPE "public"."platformRegionStatus" AS ENUM('active', 'draining', 'offline');--> statement-breakpoint
CREATE TABLE "api_credential_scope" (
	"api_key_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"permissions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"project_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"environment_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"service_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_verification" (
	"domain_verification_id" text PRIMARY KEY NOT NULL,
	"domain_id" text NOT NULL,
	"status" "domainVerificationStatus" DEFAULT 'pending' NOT NULL,
	"method" "domainVerificationMethod" NOT NULL,
	"challenge_name" text,
	"challenge_value" text,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_data_resource" (
	"managed_data_resource_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"region_id" text,
	"provider" text NOT NULL,
	"provider_resource_id" text,
	"kind" "managedDataKind" NOT NULL,
	"status" "managedDataStatus" DEFAULT 'provisioning' NOT NULL,
	"name" text NOT NULL,
	"plan" text NOT NULL,
	"connection_uri" text,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"usage_event_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text,
	"environment_id" text,
	"application_id" text,
	"deployment_id" text,
	"metric" "usageMetric" NOT NULL,
	"source" "usageSource" NOT NULL,
	"quantity" bigint NOT NULL,
	"unit" text NOT NULL,
	"cost_micros" bigint,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_quota" (
	"usage_quota_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"metric" "usageMetric" NOT NULL,
	"window" "usageQuotaWindow" NOT NULL,
	"limit_quantity" bigint NOT NULL,
	"action" "usageQuotaAction" DEFAULT 'block' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_cluster" (
	"cluster_id" text PRIMARY KEY NOT NULL,
	"region_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"runtime" "platformClusterRuntime" NOT NULL,
	"status" "platformClusterStatus" DEFAULT 'provisioning' NOT NULL,
	"api_endpoint" text,
	"kubeconfig" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_node_pool" (
	"node_pool_id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"name" text NOT NULL,
	"purpose" "platformNodePoolPurpose" NOT NULL,
	"status" "platformNodePoolStatus" DEFAULT 'active' NOT NULL,
	"architecture" text DEFAULT 'amd64' NOT NULL,
	"runtime_class_name" text,
	"min_nodes" integer DEFAULT 0 NOT NULL,
	"max_nodes" integer DEFAULT 10 NOT NULL,
	"labels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"taints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_placement" (
	"placement_id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"cluster_id" text NOT NULL,
	"node_pool_id" text,
	"runtime" "platformClusterRuntime" NOT NULL,
	"namespace" text NOT NULL,
	"status" "platformPlacementStatus" DEFAULT 'pending' NOT NULL,
	"desired_replicas" integer DEFAULT 1 NOT NULL,
	"last_reconciled_at" timestamp,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_region" (
	"region_id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"location" text NOT NULL,
	"status" "platformRegionStatus" DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_credential_scope" ADD CONSTRAINT "api_credential_scope_api_key_id_apikey_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."apikey"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_credential_scope" ADD CONSTRAINT "api_credential_scope_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_verification" ADD CONSTRAINT "domain_verification_domain_id_domain_domainId_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domain"("domainId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_project_id_project_projectId_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_environment_id_environment_environmentId_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_region_id_platform_region_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."platform_region"("region_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_project_id_project_projectId_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("projectId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_environment_id_environment_environmentId_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environmentId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_event" ADD CONSTRAINT "usage_event_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_quota" ADD CONSTRAINT "usage_quota_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_cluster" ADD CONSTRAINT "platform_cluster_region_id_platform_region_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."platform_region"("region_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_node_pool" ADD CONSTRAINT "platform_node_pool_cluster_id_platform_cluster_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."platform_cluster"("cluster_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_placement" ADD CONSTRAINT "platform_placement_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_placement" ADD CONSTRAINT "platform_placement_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_placement" ADD CONSTRAINT "platform_placement_cluster_id_platform_cluster_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."platform_cluster"("cluster_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_placement" ADD CONSTRAINT "platform_placement_node_pool_id_platform_node_pool_node_pool_id_fk" FOREIGN KEY ("node_pool_id") REFERENCES "public"."platform_node_pool"("node_pool_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apiCredentialScope_organizationId_idx" ON "api_credential_scope" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "domainVerification_domainId_unique" ON "domain_verification" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "domainVerification_status_idx" ON "domain_verification" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataResource_idempotencyKey_unique" ON "managed_data_resource" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataResource_providerResource_unique" ON "managed_data_resource" USING btree ("provider","provider_resource_id");--> statement-breakpoint
CREATE INDEX "managedDataResource_organizationStatus_idx" ON "managed_data_resource" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "managedDataResource_environment_idx" ON "managed_data_resource" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usageEvent_idempotencyKey_unique" ON "usage_event" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "usageEvent_organizationMetricPeriod_idx" ON "usage_event" USING btree ("organization_id","metric","period_start");--> statement-breakpoint
CREATE INDEX "usageEvent_applicationPeriod_idx" ON "usage_event" USING btree ("application_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "usageQuota_organizationMetricWindow_unique" ON "usage_quota" USING btree ("organization_id","metric","window");--> statement-breakpoint
CREATE INDEX "usageQuota_organizationEnabled_idx" ON "usage_quota" USING btree ("organization_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "platformCluster_slug_unique" ON "platform_cluster" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "platformCluster_regionId_idx" ON "platform_cluster" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "platformCluster_runtimeStatus_idx" ON "platform_cluster" USING btree ("runtime","status");--> statement-breakpoint
CREATE UNIQUE INDEX "platformNodePool_clusterName_unique" ON "platform_node_pool" USING btree ("cluster_id","name");--> statement-breakpoint
CREATE INDEX "platformNodePool_clusterPurpose_idx" ON "platform_node_pool" USING btree ("cluster_id","purpose","status");--> statement-breakpoint
CREATE UNIQUE INDEX "platformPlacement_applicationId_unique" ON "platform_placement" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platformPlacement_namespace_unique" ON "platform_placement" USING btree ("namespace");--> statement-breakpoint
CREATE INDEX "platformPlacement_clusterStatus_idx" ON "platform_placement" USING btree ("cluster_id","status");--> statement-breakpoint
CREATE INDEX "platformPlacement_organizationId_idx" ON "platform_placement" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platformRegion_slug_unique" ON "platform_region" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "platformRegion_status_idx" ON "platform_region" USING btree ("status");