import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { organization } from "./account";
import { applications } from "./application";
import { encryptedText } from "./utils";

export const platformRegionStatus = pgEnum("platformRegionStatus", [
	"active",
	"draining",
	"offline",
]);

export const platformClusterRuntime = pgEnum("platformClusterRuntime", [
	"swarm",
	"kubernetes",
]);

export const platformClusterStatus = pgEnum("platformClusterStatus", [
	"provisioning",
	"active",
	"draining",
	"error",
	"offline",
]);

export const platformNodePoolPurpose = pgEnum("platformNodePoolPurpose", [
	"runtime",
	"build",
	"system",
]);

export const platformNodePoolStatus = pgEnum("platformNodePoolStatus", [
	"active",
	"draining",
	"offline",
]);

export const platformTargetStatus = pgEnum("platformTargetStatus", [
	"provisioning",
	"active",
	"draining",
	"error",
	"offline",
]);

export const platformRegistryAuthMode = pgEnum("platformRegistryAuthMode", [
	"basic",
	"workload_identity",
]);

export const platformPlacementStatus = pgEnum("platformPlacementStatus", [
	"pending",
	"active",
	"draining",
	"failed",
]);

export const platformRegions = pgTable(
	"platform_region",
	{
		regionId: text("region_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		provider: text("provider").notNull(),
		location: text("location").notNull(),
		status: platformRegionStatus("status").notNull().default("active"),
		isDefault: boolean("is_default").notNull().default(false),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformRegion_slug_unique").on(table.slug),
		index("platformRegion_status_idx").on(table.status),
	],
);

export type PlatformClusterMetadata = {
	builderImage?: string;
	inCluster?: boolean;
	buildRuntimeClassName?: string;
	runtimeClassName?: string;
	gatewayNamespace?: string;
	gatewayName?: string;
	gatewaySectionName?: string;
	gatewayClassName?: string;
	registrySecretName?: string;
	secretsEncryptionEnabled?: boolean;
	networkPolicyEnabled?: boolean;
	metricsServerEnabled?: boolean;
	gatewayApiEnabled?: boolean;
	certManagerEnabled?: boolean;
	certIssuerName?: string;
	allowedEgressCidrs?: string[];
};

export const platformClusters = pgTable(
	"platform_cluster",
	{
		clusterId: text("cluster_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		regionId: text("region_id")
			.notNull()
			.references(() => platformRegions.regionId, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		runtime: platformClusterRuntime("runtime").notNull(),
		status: platformClusterStatus("status").notNull().default("provisioning"),
		apiEndpoint: text("api_endpoint"),
		kubeconfig: encryptedText("kubeconfig"),
		isDefault: boolean("is_default").notNull().default(false),
		metadata: jsonb("metadata")
			.$type<PlatformClusterMetadata>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformCluster_slug_unique").on(table.slug),
		index("platformCluster_regionId_idx").on(table.regionId),
		index("platformCluster_runtimeStatus_idx").on(table.runtime, table.status),
	],
);

export type PlatformNodeTaint = {
	key: string;
	value?: string;
	effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

export type PlatformBuildPoolMetadata = {
	registryCredentialHelperConfigured?: boolean;
	runtimeImagePullIdentityConfigured?: boolean;
};

export const platformNodePools = pgTable(
	"platform_node_pool",
	{
		nodePoolId: text("node_pool_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clusterId: text("cluster_id")
			.notNull()
			.references(() => platformClusters.clusterId, { onDelete: "cascade" }),
		name: text("name").notNull(),
		purpose: platformNodePoolPurpose("purpose").notNull(),
		status: platformNodePoolStatus("status").notNull().default("active"),
		architecture: text("architecture").notNull().default("amd64"),
		runtimeClassName: text("runtime_class_name"),
		minNodes: integer("min_nodes").notNull().default(0),
		maxNodes: integer("max_nodes").notNull().default(10),
		labels: jsonb("labels")
			.$type<Record<string, string>>()
			.notNull()
			.default({}),
		taints: jsonb("taints").$type<PlatformNodeTaint[]>().notNull().default([]),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformNodePool_clusterName_unique").on(
			table.clusterId,
			table.name,
		),
		index("platformNodePool_clusterPurpose_idx").on(
			table.clusterId,
			table.purpose,
			table.status,
		),
	],
);

export const platformRuntimeTargets = pgTable(
	"platform_runtime_target",
	{
		runtimeTargetId: text("runtime_target_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clusterId: text("cluster_id")
			.notNull()
			.references(() => platformClusters.clusterId, { onDelete: "cascade" }),
		nodePoolId: text("node_pool_id").references(
			() => platformNodePools.nodePoolId,
			{ onDelete: "restrict" },
		),
		name: text("name").notNull(),
		runtime: platformClusterRuntime("runtime").notNull(),
		status: platformTargetStatus("status").notNull().default("provisioning"),
		maxPlacements: integer("max_placements").notNull().default(1_000),
		weight: integer("weight").notNull().default(100),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformRuntimeTarget_clusterName_unique").on(
			table.clusterId,
			table.name,
		),
		index("platformRuntimeTarget_runtimeStatus_idx").on(
			table.runtime,
			table.status,
		),
		index("platformRuntimeTarget_nodePoolId_idx").on(table.nodePoolId),
	],
);

export const platformBuildPools = pgTable(
	"platform_build_pool",
	{
		buildPoolId: text("build_pool_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		clusterId: text("cluster_id")
			.notNull()
			.references(() => platformClusters.clusterId, { onDelete: "cascade" }),
		nodePoolId: text("node_pool_id").references(
			() => platformNodePools.nodePoolId,
			{ onDelete: "restrict" },
		),
		name: text("name").notNull(),
		runtime: platformClusterRuntime("runtime").notNull(),
		status: platformTargetStatus("status").notNull().default("provisioning"),
		builderImage: text("builder_image"),
		runtimeClassName: text("runtime_class_name"),
		maxConcurrentBuilds: integer("max_concurrent_builds").notNull().default(10),
		registryHost: text("registry_host"),
		registryRepositoryPrefix: text("registry_repository_prefix"),
		registryAuthMode: platformRegistryAuthMode("registry_auth_mode")
			.notNull()
			.default("basic"),
		registryUsername: encryptedText("registry_username"),
		registryPassword: encryptedText("registry_password"),
		runtimeRegistrySecretName: text("runtime_registry_secret_name"),
		metadata: jsonb("metadata")
			.$type<PlatformBuildPoolMetadata>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformBuildPool_clusterName_unique").on(
			table.clusterId,
			table.name,
		),
		index("platformBuildPool_runtimeStatus_idx").on(
			table.runtime,
			table.status,
		),
		index("platformBuildPool_nodePoolId_idx").on(table.nodePoolId),
	],
);

export const platformPlacements = pgTable(
	"platform_placement",
	{
		placementId: text("placement_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		runtimeTargetId: text("runtime_target_id")
			.notNull()
			.references(() => platformRuntimeTargets.runtimeTargetId, {
				onDelete: "restrict",
			}),
		buildPoolId: text("build_pool_id")
			.notNull()
			.references(() => platformBuildPools.buildPoolId, {
				onDelete: "restrict",
			}),
		namespace: text("namespace").notNull(),
		status: platformPlacementStatus("status").notNull().default("pending"),
		desiredReplicas: integer("desired_replicas").notNull().default(1),
		lastReconciledAt: timestamp("last_reconciled_at"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformPlacement_applicationId_unique").on(
			table.applicationId,
		),
		uniqueIndex("platformPlacement_namespace_unique").on(table.namespace),
		index("platformPlacement_runtimeTargetStatus_idx").on(
			table.runtimeTargetId,
			table.status,
		),
		index("platformPlacement_buildPoolId_idx").on(table.buildPoolId),
		index("platformPlacement_organizationId_idx").on(table.organizationId),
	],
);

export const platformRegionRelations = relations(
	platformRegions,
	({ many }) => ({ clusters: many(platformClusters) }),
);

export const platformClusterRelations = relations(
	platformClusters,
	({ one, many }) => ({
		region: one(platformRegions, {
			fields: [platformClusters.regionId],
			references: [platformRegions.regionId],
		}),
		nodePools: many(platformNodePools),
		runtimeTargets: many(platformRuntimeTargets),
		buildPools: many(platformBuildPools),
	}),
);

export const platformNodePoolRelations = relations(
	platformNodePools,
	({ one, many }) => ({
		cluster: one(platformClusters, {
			fields: [platformNodePools.clusterId],
			references: [platformClusters.clusterId],
		}),
		runtimeTargets: many(platformRuntimeTargets),
		buildPools: many(platformBuildPools),
	}),
);

export const platformRuntimeTargetRelations = relations(
	platformRuntimeTargets,
	({ one, many }) => ({
		cluster: one(platformClusters, {
			fields: [platformRuntimeTargets.clusterId],
			references: [platformClusters.clusterId],
		}),
		nodePool: one(platformNodePools, {
			fields: [platformRuntimeTargets.nodePoolId],
			references: [platformNodePools.nodePoolId],
		}),
		placements: many(platformPlacements),
	}),
);

export const platformBuildPoolRelations = relations(
	platformBuildPools,
	({ one, many }) => ({
		cluster: one(platformClusters, {
			fields: [platformBuildPools.clusterId],
			references: [platformClusters.clusterId],
		}),
		nodePool: one(platformNodePools, {
			fields: [platformBuildPools.nodePoolId],
			references: [platformNodePools.nodePoolId],
		}),
		placements: many(platformPlacements),
	}),
);

export const platformPlacementRelations = relations(
	platformPlacements,
	({ one }) => ({
		application: one(applications, {
			fields: [platformPlacements.applicationId],
			references: [applications.applicationId],
		}),
		organization: one(organization, {
			fields: [platformPlacements.organizationId],
			references: [organization.id],
		}),
		runtimeTarget: one(platformRuntimeTargets, {
			fields: [platformPlacements.runtimeTargetId],
			references: [platformRuntimeTargets.runtimeTargetId],
		}),
		buildPool: one(platformBuildPools, {
			fields: [platformPlacements.buildPoolId],
			references: [platformBuildPools.buildPoolId],
		}),
	}),
);

export type PlatformRegion = typeof platformRegions.$inferSelect;
export type PlatformCluster = typeof platformClusters.$inferSelect;
export type PlatformNodePool = typeof platformNodePools.$inferSelect;
export type PlatformRuntimeTarget = typeof platformRuntimeTargets.$inferSelect;
export type PlatformBuildPool = typeof platformBuildPools.$inferSelect;
export type PlatformPlacement = typeof platformPlacements.$inferSelect;
