CREATE TYPE "public"."platformEdgeProviderType" AS ENUM('cloudflare');--> statement-breakpoint
CREATE TYPE "public"."platformEdgePublicationKind" AS ENUM('dns', 'custom_hostname', 'load_balancer');--> statement-breakpoint
CREATE TYPE "public"."platformObjectStorageType" AS ENUM('r2', 's3');--> statement-breakpoint
CREATE TYPE "public"."platformPublicationStatus" AS ENUM('pending', 'active', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."platformServiceStatus" AS ENUM('provisioning', 'active', 'draining', 'error', 'offline');--> statement-breakpoint
CREATE TABLE "platform_edge_provider" (
	"edge_provider_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" "platformEdgeProviderType" DEFAULT 'cloudflare' NOT NULL,
	"status" "platformServiceStatus" DEFAULT 'provisioning' NOT NULL,
	"account_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"zone_name" text NOT NULL,
	"api_token" text NOT NULL,
	"origin_hostname" text NOT NULL,
	"origin_token" text NOT NULL,
	"origin_token_hash" text,
	"managed_domain" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_edge_publication" (
	"edge_publication_id" text PRIMARY KEY NOT NULL,
	"edge_provider_id" text NOT NULL,
	"application_id" text NOT NULL,
	"deployment_id" text,
	"release_identity" text NOT NULL,
	"hostname" text NOT NULL,
	"kind" "platformEdgePublicationKind" NOT NULL,
	"status" "platformPublicationStatus" DEFAULT 'pending' NOT NULL,
	"provider_resource_id" text,
	"origin_hostname" text NOT NULL,
	"last_metered_at" timestamp DEFAULT now() NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_object_storage" (
	"object_storage_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" "platformObjectStorageType" NOT NULL,
	"status" "platformServiceStatus" DEFAULT 'provisioning' NOT NULL,
	"endpoint" text NOT NULL,
	"region" text NOT NULL,
	"bucket" text NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_access_key" text NOT NULL,
	"public_base_url" text NOT NULL,
	"prefix" text DEFAULT 'vlyv-assets' NOT NULL,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_static_asset_publication" (
	"static_asset_publication_id" text PRIMARY KEY NOT NULL,
	"object_storage_id" text NOT NULL,
	"application_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"status" "platformPublicationStatus" DEFAULT 'pending' NOT NULL,
	"object_prefix" text NOT NULL,
	"public_base_url" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_edge_publication" ADD CONSTRAINT "platform_edge_publication_edge_provider_id_platform_edge_provider_edge_provider_id_fk" FOREIGN KEY ("edge_provider_id") REFERENCES "public"."platform_edge_provider"("edge_provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_edge_publication" ADD CONSTRAINT "platform_edge_publication_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_edge_publication" ADD CONSTRAINT "platform_edge_publication_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_static_asset_publication" ADD CONSTRAINT "platform_static_asset_publication_object_storage_id_platform_object_storage_object_storage_id_fk" FOREIGN KEY ("object_storage_id") REFERENCES "public"."platform_object_storage"("object_storage_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_static_asset_publication" ADD CONSTRAINT "platform_static_asset_publication_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_static_asset_publication" ADD CONSTRAINT "platform_static_asset_publication_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platformEdgeProvider_name_unique" ON "platform_edge_provider" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "platformEdgeProvider_default_unique" ON "platform_edge_provider" USING btree ("is_default") WHERE "platform_edge_provider"."is_default" = true;--> statement-breakpoint
CREATE INDEX "platformEdgeProvider_statusDefault_idx" ON "platform_edge_provider" USING btree ("status","is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "platformEdgePublication_providerHostname_unique" ON "platform_edge_publication" USING btree ("edge_provider_id","hostname");--> statement-breakpoint
CREATE INDEX "platformEdgePublication_applicationStatus_idx" ON "platform_edge_publication" USING btree ("application_id","release_identity","status");--> statement-breakpoint
CREATE INDEX "platformEdgePublication_metering_idx" ON "platform_edge_publication" USING btree ("status","last_metered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platformObjectStorage_name_unique" ON "platform_object_storage" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "platformObjectStorage_default_unique" ON "platform_object_storage" USING btree ("is_default") WHERE "platform_object_storage"."is_default" = true;--> statement-breakpoint
CREATE INDEX "platformObjectStorage_statusDefault_idx" ON "platform_object_storage" USING btree ("status","is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "platformStaticAssetPublication_deployment_unique" ON "platform_static_asset_publication" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "platformStaticAssetPublication_application_idx" ON "platform_static_asset_publication" USING btree ("application_id","created_at");