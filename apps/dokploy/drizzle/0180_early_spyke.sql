CREATE TYPE "public"."releaseState" AS ENUM('queued', 'preparing', 'building', 'artifact_ready', 'scheduling', 'verifying', 'ready', 'failed', 'rolling_back', 'rolled_back', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."releaseEventType" AS ENUM('created', 'transitioned', 'artifact_recorded', 'health_checked', 'rollback_requested', 'reconciled');--> statement-breakpoint
CREATE TABLE "build_artifact" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"application_id" text NOT NULL,
	"image_id" text NOT NULL,
	"image_digest" text,
	"image_ref" text NOT NULL,
	"image_size_bytes" bigint,
	"builder" text NOT NULL,
	"executor" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_metric" (
	"metric_id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"application_id" text NOT NULL,
	"build_duration_ms" integer,
	"image_size_bytes" bigint,
	"runtime_duration_ms" integer,
	"readiness_duration_ms" integer,
	"health_check_count" integer DEFAULT 0 NOT NULL,
	"health_check_pass_count" integer DEFAULT 0 NOT NULL,
	"health_check_fail_count" integer DEFAULT 0 NOT NULL,
	"health_check_latency_ms" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "release" (
	"release_id" text PRIMARY KEY NOT NULL,
	"deployment_id" text NOT NULL,
	"application_id" text NOT NULL,
	"artifact_id" text,
	"previous_artifact_id" text,
	"previous_image_ref" text,
	"state" "releaseState" DEFAULT 'queued' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"runtime_provider" text DEFAULT 'swarm' NOT NULL,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"heartbeat_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "release_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"release_id" text NOT NULL,
	"event_type" "releaseEventType" NOT NULL,
	"from_state" "releaseState",
	"to_state" "releaseState" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "build_artifact" ADD CONSTRAINT "build_artifact_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_artifact" ADD CONSTRAINT "build_artifact_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_metric" ADD CONSTRAINT "deployment_metric_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_metric" ADD CONSTRAINT "deployment_metric_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_deployment_id_deployment_deploymentId_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployment"("deploymentId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_application_id_application_applicationId_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("applicationId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_artifact_id_build_artifact_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."build_artifact"("artifact_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release" ADD CONSTRAINT "release_previous_artifact_id_build_artifact_artifact_id_fk" FOREIGN KEY ("previous_artifact_id") REFERENCES "public"."build_artifact"("artifact_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_event" ADD CONSTRAINT "release_event_release_id_release_release_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."release"("release_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "buildArtifact_deploymentId_unique" ON "build_artifact" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "buildArtifact_applicationId_idx" ON "build_artifact" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "buildArtifact_imageDigest_idx" ON "build_artifact" USING btree ("image_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "deploymentMetric_deploymentId_unique" ON "deployment_metric" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deploymentMetric_applicationId_idx" ON "deployment_metric" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "release_deploymentId_unique" ON "release" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "release_applicationId_idx" ON "release" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "release_state_idx" ON "release" USING btree ("state");--> statement-breakpoint
CREATE INDEX "release_heartbeatAt_idx" ON "release" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "releaseEvent_releaseId_idx" ON "release_event" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "releaseEvent_createdAt_idx" ON "release_event" USING btree ("created_at");