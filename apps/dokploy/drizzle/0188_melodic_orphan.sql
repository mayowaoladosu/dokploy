CREATE TYPE "public"."gitDeliveryProvider" AS ENUM('github', 'gitlab', 'gitea', 'bitbucket', 'soft_serve', 'docker', 'generic');--> statement-breakpoint
CREATE TYPE "public"."gitDeliveryReportStatus" AS ENUM('pending', 'synced', 'failed');--> statement-breakpoint
CREATE TYPE "public"."gitDeliveryStatus" AS ENUM('received', 'accepted', 'completed', 'failed', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."gitDeliveryTargetStatus" AS ENUM('pending', 'enqueued', 'running', 'succeeded', 'failed', 'cancelled', 'ignored');--> statement-breakpoint
CREATE TABLE "git_branch_environment_mapping" (
	"git_branch_environment_mapping_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"application_id" text NOT NULL,
	"provider" "gitDeliveryProvider" NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"branch" text NOT NULL,
	"auto_deploy" boolean DEFAULT true NOT NULL,
	"is_production" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_delivery" (
	"git_delivery_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"git_provider_id" text,
	"provider_connection_id" text,
	"provider" "gitDeliveryProvider" NOT NULL,
	"provider_scope_hash" text NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"repository_owner" text,
	"repository_name" text,
	"branch" text,
	"commit_sha" text,
	"commit_message" text,
	"payload_hash" text NOT NULL,
	"signature_verified" boolean NOT NULL,
	"status" "gitDeliveryStatus" DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gitDelivery_signatureVerified_check" CHECK ("git_delivery"."signature_verified" = true)
);
--> statement-breakpoint
CREATE TABLE "git_delivery_target" (
	"git_delivery_target_id" text PRIMARY KEY NOT NULL,
	"git_delivery_id" text NOT NULL,
	"target_key" text NOT NULL,
	"application_id" text,
	"compose_id" text,
	"preview_deployment_id" text,
	"status" "gitDeliveryTargetStatus" DEFAULT 'pending' NOT NULL,
	"workflow_id" text,
	"job" jsonb NOT NULL,
	"target_name" text NOT NULL,
	"details_url" text,
	"external_check_id" text,
	"external_comment_id" text,
	"report_status" "gitDeliveryReportStatus" DEFAULT 'pending' NOT NULL,
	"report_attempts" integer DEFAULT 0 NOT NULL,
	"next_report_at" timestamp DEFAULT now() NOT NULL,
	"report_error_message" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"error_message" text,
	"enqueued_at" timestamp,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "gitDeliveryTarget_owner_check" CHECK (num_nonnulls("git_delivery_target"."application_id", "git_delivery_target"."compose_id", "git_delivery_target"."preview_deployment_id") >= 1)
);
--> statement-breakpoint
ALTER TABLE "git_branch_environment_mapping" ADD CONSTRAINT "git_branch_environment_mapping_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_environment_mapping" ADD CONSTRAINT "git_branch_environment_mapping_project_id_project_projectId_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("projectId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_environment_mapping" ADD CONSTRAINT "git_branch_environment_mapping_environment_id_environment_environmentId_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environment"("environmentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_branch_environment_mapping" ADD CONSTRAINT "git_branch_environment_mapping_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_delivery" ADD CONSTRAINT "git_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_delivery" ADD CONSTRAINT "git_delivery_git_provider_id_git_provider_gitProviderId_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_provider"("gitProviderId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_delivery_target" ADD CONSTRAINT "git_delivery_target_git_delivery_id_git_delivery_git_delivery_id_fk" FOREIGN KEY ("git_delivery_id") REFERENCES "public"."git_delivery"("git_delivery_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_delivery_target" ADD CONSTRAINT "git_delivery_target_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_delivery_target" ADD CONSTRAINT "git_delivery_target_compose_id_compose_composeId_fk" FOREIGN KEY ("compose_id") REFERENCES "public"."compose"("composeId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_delivery_target" ADD CONSTRAINT "git_delivery_target_preview_deployment_id_preview_deployments_previewDeploymentId_fk" FOREIGN KEY ("preview_deployment_id") REFERENCES "public"."preview_deployments"("previewDeploymentId") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitBranchMapping_applicationBranch_unique" ON "git_branch_environment_mapping" USING btree ("application_id","branch");--> statement-breakpoint
CREATE INDEX "gitBranchMapping_lookup_idx" ON "git_branch_environment_mapping" USING btree ("organization_id","provider","repository_owner","repository_name","branch");--> statement-breakpoint
CREATE INDEX "gitBranchMapping_environment_idx" ON "git_branch_environment_mapping" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gitDelivery_scopeDelivery_unique" ON "git_delivery" USING btree ("organization_id","provider","provider_scope_hash","provider_delivery_id");--> statement-breakpoint
CREATE INDEX "gitDelivery_statusRetry_idx" ON "git_delivery" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "gitDelivery_repository_idx" ON "git_delivery" USING btree ("organization_id","provider","repository_owner","repository_name");--> statement-breakpoint
CREATE UNIQUE INDEX "gitDeliveryTarget_deliveryTarget_unique" ON "git_delivery_target" USING btree ("git_delivery_id","target_key");--> statement-breakpoint
CREATE INDEX "gitDeliveryTarget_retry_idx" ON "git_delivery_target" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "gitDeliveryTarget_report_idx" ON "git_delivery_target" USING btree ("report_status","next_report_at");--> statement-breakpoint
CREATE INDEX "gitDeliveryTarget_application_idx" ON "git_delivery_target" USING btree ("application_id");
--> statement-breakpoint
INSERT INTO "git_branch_environment_mapping" (
	"git_branch_environment_mapping_id",
	"organization_id",
	"project_id",
	"environment_id",
	"application_id",
	"provider",
	"repository_owner",
	"repository_name",
	"branch",
	"auto_deploy",
	"is_production"
)
SELECT
	'legacy-' || md5(application."applicationId" || ':' || source.branch),
	project."organizationId",
	project."projectId",
	environment."environmentId",
	application."applicationId",
	source.provider::"gitDeliveryProvider",
	source.owner,
	source.repository,
	source.branch,
	COALESCE(application."autoDeploy", true),
	environment."isDefault" AND lower(source.branch) IN ('main', 'master', 'production')
FROM "application" AS application
JOIN "environment" AS environment ON environment."environmentId" = application."environmentId"
JOIN "project" AS project ON project."projectId" = environment."projectId"
CROSS JOIN LATERAL (
	SELECT
		CASE application."sourceType"::text
			WHEN 'github' THEN 'github'
			WHEN 'gitlab' THEN 'gitlab'
			WHEN 'gitea' THEN 'gitea'
			WHEN 'bitbucket' THEN 'bitbucket'
		END AS provider,
		CASE application."sourceType"::text
			WHEN 'github' THEN application."owner"
			WHEN 'gitlab' THEN application."gitlabOwner"
			WHEN 'gitea' THEN application."giteaOwner"
			WHEN 'bitbucket' THEN application."bitbucketOwner"
		END AS owner,
		CASE application."sourceType"::text
			WHEN 'github' THEN application."repository"
			WHEN 'gitlab' THEN application."gitlabRepository"
			WHEN 'gitea' THEN application."giteaRepository"
			WHEN 'bitbucket' THEN COALESCE(application."bitbucketRepositorySlug", application."bitbucketRepository")
		END AS repository,
		CASE application."sourceType"::text
			WHEN 'github' THEN application."branch"
			WHEN 'gitlab' THEN application."gitlabBranch"
			WHEN 'gitea' THEN application."giteaBranch"
			WHEN 'bitbucket' THEN application."bitbucketBranch"
		END AS branch
) AS source
WHERE source.provider IS NOT NULL
	AND source.owner IS NOT NULL
	AND source.repository IS NOT NULL
	AND source.branch IS NOT NULL
ON CONFLICT ("application_id", "branch") DO NOTHING;
--> statement-breakpoint
UPDATE "preview_deployments"
SET "expiresAt" = to_char(
	("createdAt"::timestamptz + interval '7 days') AT TIME ZONE 'UTC',
	'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
)
WHERE "expiresAt" IS NULL
	AND "createdAt" ~ '^\\d{4}-\\d{2}-\\d{2}T';