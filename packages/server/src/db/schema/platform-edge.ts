import { relations, sql } from "drizzle-orm";
import {
	bigint,
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
import { applications } from "./application";
import { deployments } from "./deployment";
import { encryptedText } from "./utils";

export const platformServiceStatus = pgEnum("platformServiceStatus", [
	"provisioning",
	"active",
	"draining",
	"error",
	"offline",
]);

export const platformEdgeProviderType = pgEnum("platformEdgeProviderType", [
	"cloudflare",
]);

export const platformObjectStorageType = pgEnum("platformObjectStorageType", [
	"r2",
	"s3",
]);

export const platformEdgePublicationKind = pgEnum(
	"platformEdgePublicationKind",
	["dns", "custom_hostname", "load_balancer"],
);

export const platformPublicationStatus = pgEnum("platformPublicationStatus", [
	"pending",
	"active",
	"failed",
	"deleting",
]);

export type PlatformEdgeProviderMetadata = {
	customHostnamesEnabled?: boolean;
	managedWafEnabled?: boolean;
	cacheEnabled?: boolean;
	geoRoutingEnabled?: boolean;
	originLockdownEnabled?: boolean;
	authenticatedOriginPullsEnabled?: boolean;
	analyticsEnabled?: boolean;
	cacheTtlSeconds?: number;
	browserTtlSeconds?: number;
	loadBalancerPoolIds?: string[];
	loadBalancerFallbackPoolId?: string;
	loadBalancerRegionPools?: Record<string, string[]>;
};

export const platformEdgeProviders = pgTable(
	"platform_edge_provider",
	{
		edgeProviderId: text("edge_provider_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		provider: platformEdgeProviderType("provider")
			.notNull()
			.default("cloudflare"),
		status: platformServiceStatus("status").notNull().default("provisioning"),
		accountId: text("account_id").notNull(),
		zoneId: text("zone_id").notNull(),
		zoneName: text("zone_name").notNull(),
		apiToken: encryptedText("api_token").notNull(),
		originHostname: text("origin_hostname").notNull(),
		originToken: encryptedText("origin_token").notNull(),
		originTokenHash: text("origin_token_hash"),
		managedDomain: text("managed_domain").notNull(),
		isDefault: boolean("is_default").notNull().default(false),
		metadata: jsonb("metadata")
			.$type<PlatformEdgeProviderMetadata>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformEdgeProvider_name_unique").on(table.name),
		uniqueIndex("platformEdgeProvider_default_unique")
			.on(table.isDefault)
			.where(sql`${table.isDefault} = true`),
		index("platformEdgeProvider_statusDefault_idx").on(
			table.status,
			table.isDefault,
		),
	],
);

export type PlatformObjectStorageMetadata = {
	serverSideEncryption?: "AES256" | "aws:kms";
	kmsKeyId?: string;
	cacheControl?: string;
};

export const platformObjectStorages = pgTable(
	"platform_object_storage",
	{
		objectStorageId: text("object_storage_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		provider: platformObjectStorageType("provider").notNull(),
		status: platformServiceStatus("status").notNull().default("provisioning"),
		endpoint: text("endpoint").notNull(),
		region: text("region").notNull(),
		bucket: text("bucket").notNull(),
		accessKeyId: encryptedText("access_key_id").notNull(),
		secretAccessKey: encryptedText("secret_access_key").notNull(),
		publicBaseUrl: text("public_base_url").notNull(),
		prefix: text("prefix").notNull().default("vlyv-assets"),
		forcePathStyle: boolean("force_path_style").notNull().default(false),
		isDefault: boolean("is_default").notNull().default(false),
		metadata: jsonb("metadata")
			.$type<PlatformObjectStorageMetadata>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformObjectStorage_name_unique").on(table.name),
		uniqueIndex("platformObjectStorage_default_unique")
			.on(table.isDefault)
			.where(sql`${table.isDefault} = true`),
		index("platformObjectStorage_statusDefault_idx").on(
			table.status,
			table.isDefault,
		),
	],
);

export const platformEdgePublications = pgTable(
	"platform_edge_publication",
	{
		edgePublicationId: text("edge_publication_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		edgeProviderId: text("edge_provider_id")
			.notNull()
			.references(() => platformEdgeProviders.edgeProviderId, {
				onDelete: "restrict",
			}),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		deploymentId: text("deployment_id").references(
			() => deployments.deploymentId,
			{ onDelete: "set null" },
		),
		releaseIdentity: text("release_identity").notNull(),
		hostname: text("hostname").notNull(),
		kind: platformEdgePublicationKind("kind").notNull(),
		status: platformPublicationStatus("status").notNull().default("pending"),
		providerResourceId: text("provider_resource_id"),
		originHostname: text("origin_hostname").notNull(),
		lastMeteredAt: timestamp("last_metered_at").defaultNow().notNull(),
		errorMessage: text("error_message"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformEdgePublication_providerHostname_unique").on(
			table.edgeProviderId,
			table.hostname,
		),
		index("platformEdgePublication_applicationStatus_idx").on(
			table.applicationId,
			table.releaseIdentity,
			table.status,
		),
		index("platformEdgePublication_metering_idx").on(
			table.status,
			table.lastMeteredAt,
		),
	],
);

export const platformStaticAssetPublications = pgTable(
	"platform_static_asset_publication",
	{
		staticAssetPublicationId: text("static_asset_publication_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		objectStorageId: text("object_storage_id")
			.notNull()
			.references(() => platformObjectStorages.objectStorageId, {
				onDelete: "restrict",
			}),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		deploymentId: text("deployment_id")
			.notNull()
			.references(() => deployments.deploymentId, { onDelete: "cascade" }),
		status: platformPublicationStatus("status").notNull().default("pending"),
		objectPrefix: text("object_prefix").notNull(),
		publicBaseUrl: text("public_base_url").notNull(),
		manifestDigest: text("manifest_digest").notNull(),
		fileCount: integer("file_count").notNull(),
		totalBytes: bigint("total_bytes", { mode: "number" }).notNull(),
		errorMessage: text("error_message"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformStaticAssetPublication_deployment_unique").on(
			table.deploymentId,
		),
		index("platformStaticAssetPublication_application_idx").on(
			table.applicationId,
			table.createdAt,
		),
	],
);

export const platformEdgeProviderRelations = relations(
	platformEdgeProviders,
	({ many }) => ({ publications: many(platformEdgePublications) }),
);

export const platformObjectStorageRelations = relations(
	platformObjectStorages,
	({ many }) => ({ publications: many(platformStaticAssetPublications) }),
);

export const platformEdgePublicationRelations = relations(
	platformEdgePublications,
	({ one }) => ({
		provider: one(platformEdgeProviders, {
			fields: [platformEdgePublications.edgeProviderId],
			references: [platformEdgeProviders.edgeProviderId],
		}),
		application: one(applications, {
			fields: [platformEdgePublications.applicationId],
			references: [applications.applicationId],
		}),
		deployment: one(deployments, {
			fields: [platformEdgePublications.deploymentId],
			references: [deployments.deploymentId],
		}),
	}),
);

export const platformStaticAssetPublicationRelations = relations(
	platformStaticAssetPublications,
	({ one }) => ({
		storage: one(platformObjectStorages, {
			fields: [platformStaticAssetPublications.objectStorageId],
			references: [platformObjectStorages.objectStorageId],
		}),
		application: one(applications, {
			fields: [platformStaticAssetPublications.applicationId],
			references: [applications.applicationId],
		}),
		deployment: one(deployments, {
			fields: [platformStaticAssetPublications.deploymentId],
			references: [deployments.deploymentId],
		}),
	}),
);

export type PlatformEdgeProvider = typeof platformEdgeProviders.$inferSelect;
export type PlatformObjectStorage = typeof platformObjectStorages.$inferSelect;
export type PlatformEdgePublication =
	typeof platformEdgePublications.$inferSelect;
export type PlatformStaticAssetPublication =
	typeof platformStaticAssetPublications.$inferSelect;
