CREATE TYPE "public"."managedDataBackupKind" AS ENUM('provider_snapshot', 'platform_archive');--> statement-breakpoint
CREATE TYPE "public"."managedDataBackupStatus" AS ENUM('pending', 'creating', 'ready', 'restoring', 'restored', 'failed', 'deleting', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."managedDataEncryptionMode" AS ENUM('provider_kms', 'platform_kms');--> statement-breakpoint
CREATE TYPE "public"."managedDataProviderStatus" AS ENUM('provisioning', 'active', 'error', 'offline');--> statement-breakpoint
CREATE TYPE "public"."managedDataProviderType" AS ENUM('neon', 'upstash', 'http');--> statement-breakpoint
ALTER TYPE "public"."managedDataStatus" ADD VALUE 'restoring';--> statement-breakpoint
CREATE TABLE "managed_data_backup" (
	"managed_data_backup_id" text PRIMARY KEY NOT NULL,
	"managed_data_resource_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"kind" "managedDataBackupKind" NOT NULL,
	"status" "managedDataBackupStatus" DEFAULT 'pending' NOT NULL,
	"provider_backup_id" text,
	"object_storage_id" text,
	"object_key" text,
	"checksum" text,
	"size_bytes" bigint,
	"encryption_mode" "managedDataEncryptionMode" NOT NULL,
	"expires_at" timestamp,
	"ready_at" timestamp,
	"restored_at" timestamp,
	"error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "managed_data_binding" (
	"managed_data_binding_id" text PRIMARY KEY NOT NULL,
	"managed_data_resource_id" text NOT NULL,
	"application_id" text NOT NULL,
	"environment_variable" text DEFAULT 'DATABASE_URL' NOT NULL,
	"applied_credential_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_managed_data_provider" (
	"managed_data_provider_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "managedDataProviderType" NOT NULL,
	"status" "managedDataProviderStatus" DEFAULT 'provisioning' NOT NULL,
	"base_url" text NOT NULL,
	"credentials" text NOT NULL,
	"kinds" "managedDataKind"[] NOT NULL,
	"default_kinds" "managedDataKind"[] DEFAULT '{}' NOT NULL,
	"capabilities" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_verified_at" timestamp,
	"error_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "managed_data_resource" DROP CONSTRAINT "managed_data_resource_organization_id_organization_id_fk";
--> statement-breakpoint
ALTER TABLE "managed_data_resource" DROP CONSTRAINT "managed_data_resource_project_id_project_projectId_fk";
--> statement-breakpoint
ALTER TABLE "managed_data_resource" DROP CONSTRAINT "managed_data_resource_environment_id_environment_environmentId_fk";
--> statement-breakpoint
DROP INDEX "managedDataResource_idempotencyKey_unique";--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "request_hash" text;--> statement-breakpoint
UPDATE "managed_data_resource"
SET "request_hash" = 'legacy:' || md5("organization_id" || ':' || "idempotency_key" || ':' || "managed_data_resource_id")
WHERE "request_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ALTER COLUMN "request_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "storage_limit_bytes" bigint;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "pitr_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "high_availability" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "pooling_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "replicas" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "backup_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "backup_interval_hours" integer DEFAULT 24 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "backup_retention_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "next_backup_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "last_backup_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "lifecycle_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "next_reconcile_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "credential_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "last_healthy_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "deletion_requested_at" timestamp;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "usage_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD COLUMN "next_usage_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "managed_data_resource" AS resource
SET
	"metadata" = resource."metadata" || jsonb_build_object(
		'providerPlan', COALESCE(resource."metadata"->>'providerPlan', resource."plan"),
		'providerRegion', COALESCE(
			resource."metadata"->>'providerRegion',
			(SELECT region."slug" FROM "platform_region" AS region WHERE region."region_id" = resource."region_id"),
			(SELECT region."slug" FROM "platform_region" AS region WHERE region."status" = 'active' ORDER BY region."is_default" DESC, region."slug" LIMIT 1),
			resource."region_id",
			'unmapped'
		)
	),
	"plan" = CASE WHEN resource."plan" IN ('starter', 'pro', 'scale') THEN resource."plan" ELSE 'starter' END,
	"storage_limit_bytes" = CASE
		WHEN resource."plan" = 'scale' THEN 107374182400
		WHEN resource."plan" = 'pro' THEN 10737418240
		ELSE 1073741824
	END,
	"retention_days" = CASE
		WHEN resource."plan" = 'scale' THEN 30
		WHEN resource."plan" = 'pro' THEN 7
		ELSE 1
	END,
	"pitr_enabled" = resource."kind" <> 'redis',
	"high_availability" = true,
	"pooling_enabled" = resource."kind" <> 'redis',
	"replicas" = CASE WHEN resource."plan" = 'scale' THEN 3 ELSE 2 END,
	"backup_enabled" = resource."status" <> 'deleted',
	"backup_interval_hours" = CASE
		WHEN resource."plan" = 'scale' THEN 6
		WHEN resource."plan" = 'pro' THEN 12
		ELSE 24
	END,
	"backup_retention_days" = CASE
		WHEN resource."plan" = 'scale' THEN 35
		WHEN resource."plan" = 'pro' THEN 14
		ELSE 7
	END,
	"next_backup_at" = CASE
		WHEN resource."status" = 'deleted' THEN NULL
		WHEN resource."plan" = 'scale' THEN now() + interval '6 hours'
		WHEN resource."plan" = 'pro' THEN now() + interval '12 hours'
		ELSE now() + interval '24 hours'
	END;--> statement-breakpoint
ALTER TABLE "managed_data_backup" ADD CONSTRAINT "managed_data_backup_managed_data_resource_id_managed_data_resource_managed_data_resource_id_fk" FOREIGN KEY ("managed_data_resource_id") REFERENCES "public"."managed_data_resource"("managed_data_resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_backup" ADD CONSTRAINT "managed_data_backup_object_storage_id_platform_object_storage_object_storage_id_fk" FOREIGN KEY ("object_storage_id") REFERENCES "public"."platform_object_storage"("object_storage_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_binding" ADD CONSTRAINT "managed_data_binding_managed_data_resource_id_managed_data_resource_managed_data_resource_id_fk" FOREIGN KEY ("managed_data_resource_id") REFERENCES "public"."managed_data_resource"("managed_data_resource_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_binding" ADD CONSTRAINT "managed_data_binding_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataBackup_resourceIdempotency_unique" ON "managed_data_backup" USING btree ("managed_data_resource_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataBackup_providerId_unique" ON "managed_data_backup" USING btree ("managed_data_resource_id","provider_backup_id") WHERE "managed_data_backup"."provider_backup_id" is not null;--> statement-breakpoint
CREATE INDEX "managedDataBackup_resourceStatus_idx" ON "managed_data_backup" USING btree ("managed_data_resource_id","status");--> statement-breakpoint
CREATE INDEX "managedDataBackup_expiry_idx" ON "managed_data_backup" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "managedDataBackup_retry_idx" ON "managed_data_backup" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataBinding_applicationVariable_unique" ON "managed_data_binding" USING btree ("application_id","environment_variable");--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataBinding_resourceApplication_unique" ON "managed_data_binding" USING btree ("managed_data_resource_id","application_id");--> statement-breakpoint
CREATE INDEX "managedDataBinding_resource_idx" ON "managed_data_binding" USING btree ("managed_data_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platformManagedDataProvider_name_unique" ON "platform_managed_data_provider" USING btree ("name");--> statement-breakpoint
CREATE INDEX "platformManagedDataProvider_status_idx" ON "platform_managed_data_provider" USING btree ("status");--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_project_id_project_projectId_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("projectId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_data_resource" ADD CONSTRAINT "managed_data_resource_environment_id_environment_environmentId_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environmentId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "managedDataResource_organizationIdempotency_unique" ON "managed_data_resource" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "managedDataResource_reconcile_idx" ON "managed_data_resource" USING btree ("status","next_reconcile_at");--> statement-breakpoint
CREATE INDEX "managedDataResource_usage_idx" ON "managed_data_resource" USING btree ("status","next_usage_at");