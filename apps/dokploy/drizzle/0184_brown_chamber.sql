CREATE TYPE "public"."platformRegistryAuthMode" AS ENUM('basic', 'workload_identity');--> statement-breakpoint
CREATE TYPE "public"."platformTargetStatus" AS ENUM('provisioning', 'active', 'draining', 'error', 'offline');--> statement-breakpoint
CREATE TABLE "platform_build_pool" (
	"build_pool_id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"node_pool_id" text,
	"name" text NOT NULL,
	"runtime" "platformClusterRuntime" NOT NULL,
	"status" "platformTargetStatus" DEFAULT 'provisioning' NOT NULL,
	"builder_image" text,
	"runtime_class_name" text,
	"max_concurrent_builds" integer DEFAULT 10 NOT NULL,
	"registry_host" text,
	"registry_repository_prefix" text,
	"registry_auth_mode" "platformRegistryAuthMode" DEFAULT 'basic' NOT NULL,
	"registry_username" text,
	"registry_password" text,
	"runtime_registry_secret_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_runtime_target" (
	"runtime_target_id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"node_pool_id" text,
	"name" text NOT NULL,
	"runtime" "platformClusterRuntime" NOT NULL,
	"status" "platformTargetStatus" DEFAULT 'provisioning' NOT NULL,
	"max_placements" integer DEFAULT 1000 NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "platform_runtime_target" (
	"runtime_target_id",
	"cluster_id",
	"node_pool_id",
	"name",
	"runtime",
	"status",
	"max_placements",
	"weight",
	"metadata"
)
SELECT
	'rt-' || substr(md5(cluster."cluster_id" || ':' || coalesce(pool."node_pool_id", 'default')), 1, 24),
	cluster."cluster_id",
	pool."node_pool_id",
	coalesce(pool."name", 'default-runtime'),
	cluster."runtime",
	CASE
		WHEN cluster."status" = 'active'
			AND (pool."node_pool_id" IS NULL OR pool."status" = 'active')
			AND (
				cluster."runtime" = 'swarm'
				OR coalesce(pool."runtime_class_name", cluster."metadata"->>'runtimeClassName') IS NOT NULL
			)
		THEN 'active'::"platformTargetStatus"
		ELSE 'provisioning'::"platformTargetStatus"
	END,
	1000,
	100,
	'{}'::jsonb
FROM "platform_cluster" cluster
LEFT JOIN "platform_node_pool" pool
	ON pool."cluster_id" = cluster."cluster_id"
	AND pool."purpose" = 'runtime';
--> statement-breakpoint
INSERT INTO "platform_build_pool" (
	"build_pool_id",
	"cluster_id",
	"node_pool_id",
	"name",
	"runtime",
	"status",
	"builder_image",
	"runtime_class_name",
	"max_concurrent_builds",
	"registry_host",
	"registry_repository_prefix",
	"registry_auth_mode",
	"registry_username",
	"registry_password",
	"runtime_registry_secret_name",
	"metadata"
)
SELECT
	'bp-' || substr(md5(cluster."cluster_id" || ':' || coalesce(pool."node_pool_id", 'default')), 1, 24),
	cluster."cluster_id",
	pool."node_pool_id",
	coalesce(pool."name", 'default-build'),
	cluster."runtime",
	CASE
		WHEN cluster."runtime" = 'swarm' AND cluster."status" = 'active'
			THEN 'active'::"platformTargetStatus"
		ELSE 'provisioning'::"platformTargetStatus"
	END,
	cluster."metadata"->>'builderImage',
	coalesce(pool."runtime_class_name", cluster."metadata"->>'buildRuntimeClassName'),
	10,
	NULL,
	NULL,
	'basic'::"platformRegistryAuthMode",
	NULL,
	NULL,
	cluster."metadata"->>'registrySecretName',
	'{}'::jsonb
FROM "platform_cluster" cluster
LEFT JOIN "platform_node_pool" pool
	ON pool."cluster_id" = cluster."cluster_id"
	AND pool."purpose" = 'build';
--> statement-breakpoint
ALTER TABLE "platform_placement" DROP CONSTRAINT "platform_placement_cluster_id_platform_cluster_cluster_id_fk";
--> statement-breakpoint
ALTER TABLE "platform_placement" DROP CONSTRAINT "platform_placement_node_pool_id_platform_node_pool_node_pool_id_fk";
--> statement-breakpoint
DROP INDEX "platformPlacement_clusterStatus_idx";--> statement-breakpoint
ALTER TABLE "platform_placement" ADD COLUMN "runtime_target_id" text;--> statement-breakpoint
ALTER TABLE "platform_placement" ADD COLUMN "build_pool_id" text;--> statement-breakpoint
UPDATE "platform_placement" placement
SET "runtime_target_id" = (
	SELECT target."runtime_target_id"
	FROM "platform_runtime_target" target
	WHERE target."cluster_id" = placement."cluster_id"
	ORDER BY
		CASE WHEN target."node_pool_id" IS NOT DISTINCT FROM placement."node_pool_id" THEN 0 ELSE 1 END,
		target."name"
	LIMIT 1
),
"build_pool_id" = (
	SELECT pool."build_pool_id"
	FROM "platform_build_pool" pool
	WHERE pool."cluster_id" = placement."cluster_id"
	ORDER BY pool."name"
	LIMIT 1
);--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "platform_placement"
		WHERE "runtime_target_id" IS NULL OR "build_pool_id" IS NULL
	) THEN
		RAISE EXCEPTION 'Unable to map every legacy placement to a runtime target and build pool';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "platform_placement" ALTER COLUMN "runtime_target_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_placement" ALTER COLUMN "build_pool_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_build_pool" ADD CONSTRAINT "platform_build_pool_cluster_id_platform_cluster_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."platform_cluster"("cluster_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_build_pool" ADD CONSTRAINT "platform_build_pool_node_pool_id_platform_node_pool_node_pool_id_fk" FOREIGN KEY ("node_pool_id") REFERENCES "public"."platform_node_pool"("node_pool_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_runtime_target" ADD CONSTRAINT "platform_runtime_target_cluster_id_platform_cluster_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."platform_cluster"("cluster_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_runtime_target" ADD CONSTRAINT "platform_runtime_target_node_pool_id_platform_node_pool_node_pool_id_fk" FOREIGN KEY ("node_pool_id") REFERENCES "public"."platform_node_pool"("node_pool_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platformBuildPool_clusterName_unique" ON "platform_build_pool" USING btree ("cluster_id","name");--> statement-breakpoint
CREATE INDEX "platformBuildPool_runtimeStatus_idx" ON "platform_build_pool" USING btree ("runtime","status");--> statement-breakpoint
CREATE INDEX "platformBuildPool_nodePoolId_idx" ON "platform_build_pool" USING btree ("node_pool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platformRuntimeTarget_clusterName_unique" ON "platform_runtime_target" USING btree ("cluster_id","name");--> statement-breakpoint
CREATE INDEX "platformRuntimeTarget_runtimeStatus_idx" ON "platform_runtime_target" USING btree ("runtime","status");--> statement-breakpoint
CREATE INDEX "platformRuntimeTarget_nodePoolId_idx" ON "platform_runtime_target" USING btree ("node_pool_id");--> statement-breakpoint
ALTER TABLE "platform_placement" ADD CONSTRAINT "platform_placement_runtime_target_id_platform_runtime_target_runtime_target_id_fk" FOREIGN KEY ("runtime_target_id") REFERENCES "public"."platform_runtime_target"("runtime_target_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_placement" ADD CONSTRAINT "platform_placement_build_pool_id_platform_build_pool_build_pool_id_fk" FOREIGN KEY ("build_pool_id") REFERENCES "public"."platform_build_pool"("build_pool_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platformPlacement_runtimeTargetStatus_idx" ON "platform_placement" USING btree ("runtime_target_id","status");--> statement-breakpoint
CREATE INDEX "platformPlacement_buildPoolId_idx" ON "platform_placement" USING btree ("build_pool_id");--> statement-breakpoint
ALTER TABLE "platform_placement" DROP COLUMN "cluster_id";--> statement-breakpoint
ALTER TABLE "platform_placement" DROP COLUMN "node_pool_id";--> statement-breakpoint
ALTER TABLE "platform_placement" DROP COLUMN "runtime";