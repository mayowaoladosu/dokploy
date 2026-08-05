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
import { organization } from "./account";
import { applications } from "./application";
import { deployments } from "./deployment";
import { managedDataResources } from "./managed-data-resource";
import {
	platformClusters,
	platformPlacements,
} from "./platform-infrastructure";
import { usageEvents, usageMetric } from "./usage-ledger";
import { user } from "./user";
import { encryptedText } from "./utils";

export const observabilityBackendKind = pgEnum("observabilityBackendKind", [
	"prometheus",
	"loki",
	"tempo",
	"clickhouse",
	"otlp",
]);

export const observabilityBackendStatus = pgEnum("observabilityBackendStatus", [
	"provisioning",
	"active",
	"error",
	"offline",
]);

export const observabilityQueryKind = pgEnum("observabilityQueryKind", [
	"metrics",
	"logs",
	"traces",
]);

export const observabilityQueryStatus = pgEnum("observabilityQueryStatus", [
	"succeeded",
	"failed",
	"denied",
]);

export const stripeUsageDeliveryStatus = pgEnum("stripeUsageDeliveryStatus", [
	"pending",
	"delivering",
	"delivered",
	"failed",
]);

export type PlatformObservabilityBackendMetadata = {
	allowInsecure?: boolean;
	allowPrivateEndpoint?: boolean;
	queryTimeoutMs?: number;
	maxResponseBytes?: number;
	retentionManagedExternally?: boolean;
	healthEndpoint?: string;
	otlpHeaders?: Record<string, string>;
};

export const platformObservabilityBackends = pgTable(
	"platform_observability_backend",
	{
		observabilityBackendId: text("observability_backend_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		kind: observabilityBackendKind("kind").notNull(),
		status: observabilityBackendStatus("status")
			.notNull()
			.default("provisioning"),
		endpoint: text("endpoint").notNull(),
		authToken: encryptedText("auth_token"),
		tenantHeader: text("tenant_header").notNull().default("X-Scope-OrgID"),
		tenantId: text("tenant_id").notNull().default("vlyv"),
		isDefault: boolean("is_default").notNull().default(false),
		metadata: jsonb("metadata")
			.$type<PlatformObservabilityBackendMetadata>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformObservabilityBackend_name_unique").on(table.name),
		uniqueIndex("platformObservabilityBackend_kindDefault_unique")
			.on(table.kind, table.isDefault)
			.where(sql`${table.isDefault} = true`),
		index("platformObservabilityBackend_kindStatus_idx").on(
			table.kind,
			table.status,
		),
	],
);

export const organizationObservabilityPolicies = pgTable(
	"organization_observability_policy",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organization.id, { onDelete: "cascade" }),
		metricsRetentionDays: integer("metrics_retention_days")
			.notNull()
			.default(30),
		logsRetentionDays: integer("logs_retention_days").notNull().default(7),
		tracesRetentionDays: integer("traces_retention_days").notNull().default(7),
		queryEnabled: boolean("query_enabled").notNull().default(true),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("organizationObservabilityPolicy_query_idx").on(table.queryEnabled),
	],
);

export const observabilityQueryAudits = pgTable(
	"observability_query_audit",
	{
		observabilityQueryAuditId: text("observability_query_audit_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		userId: text("user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		applicationId: text("application_id").references(
			() => applications.applicationId,
			{ onDelete: "set null" },
		),
		deploymentId: text("deployment_id").references(
			() => deployments.deploymentId,
			{ onDelete: "set null" },
		),
		kind: observabilityQueryKind("kind").notNull(),
		status: observabilityQueryStatus("status").notNull(),
		queryFingerprint: text("query_fingerprint").notNull(),
		resultCount: integer("result_count"),
		errorMessage: text("error_message"),
		periodStart: timestamp("period_start").notNull(),
		periodEnd: timestamp("period_end").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("observabilityQueryAudit_organizationCreated_idx").on(
			table.organizationId,
			table.createdAt,
		),
	],
);

export const runtimeUsageCheckpoints = pgTable(
	"runtime_usage_checkpoint",
	{
		placementId: text("placement_id")
			.primaryKey()
			.references(() => platformPlacements.placementId, {
				onDelete: "cascade",
			}),
		clusterId: text("cluster_id")
			.notNull()
			.references(() => platformClusters.clusterId, { onDelete: "cascade" }),
		lastMeteredAt: timestamp("last_metered_at").notNull(),
		lastSampleAt: timestamp("last_sample_at").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [index("runtimeUsageCheckpoint_cluster_idx").on(table.clusterId)],
);

export const managedDataUsageCheckpoints = pgTable(
	"managed_data_usage_checkpoint",
	{
		managedDataResourceId: text("managed_data_resource_id")
			.primaryKey()
			.references(() => managedDataResources.managedDataResourceId, {
				onDelete: "cascade",
			}),
		lastMeteredAt: timestamp("last_metered_at").notNull(),
		lastSampleAt: timestamp("last_sample_at").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("managedDataUsageCheckpoint_sample_idx").on(table.lastSampleAt),
	],
);

export const stripeUsageMeters = pgTable(
	"stripe_usage_meter",
	{
		stripeUsageMeterId: text("stripe_usage_meter_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		metric: usageMetric("metric").notNull(),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeEventName: text("stripe_event_name").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("stripeUsageMeter_organizationMetric_unique").on(
			table.organizationId,
			table.metric,
		),
		index("stripeUsageMeter_enabled_idx").on(table.enabled),
	],
);

export const stripeUsageDeliveries = pgTable(
	"stripe_usage_delivery",
	{
		stripeUsageDeliveryId: text("stripe_usage_delivery_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		stripeUsageMeterId: text("stripe_usage_meter_id")
			.notNull()
			.references(() => stripeUsageMeters.stripeUsageMeterId, {
				onDelete: "cascade",
			}),
		usageEventId: text("usage_event_id")
			.notNull()
			.references(() => usageEvents.usageEventId, { onDelete: "cascade" }),
		identifier: text("identifier").notNull(),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeEventName: text("stripe_event_name").notNull(),
		quantity: bigint("quantity", { mode: "bigint" }).notNull(),
		eventTimestamp: timestamp("event_timestamp").notNull(),
		status: stripeUsageDeliveryStatus("status").notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
		deliveredAt: timestamp("delivered_at"),
		lastError: text("last_error"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("stripeUsageDelivery_meterEvent_unique").on(
			table.stripeUsageMeterId,
			table.usageEventId,
		),
		uniqueIndex("stripeUsageDelivery_identifier_unique").on(table.identifier),
		index("stripeUsageDelivery_statusRetry_idx").on(
			table.status,
			table.nextAttemptAt,
		),
	],
);

export const organizationObservabilityPolicyRelations = relations(
	organizationObservabilityPolicies,
	({ one }) => ({
		organization: one(organization, {
			fields: [organizationObservabilityPolicies.organizationId],
			references: [organization.id],
		}),
	}),
);

export const observabilityQueryAuditRelations = relations(
	observabilityQueryAudits,
	({ one }) => ({
		organization: one(organization, {
			fields: [observabilityQueryAudits.organizationId],
			references: [organization.id],
		}),
		user: one(user, {
			fields: [observabilityQueryAudits.userId],
			references: [user.id],
		}),
	}),
);

export const stripeUsageMeterRelations = relations(
	stripeUsageMeters,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [stripeUsageMeters.organizationId],
			references: [organization.id],
		}),
		deliveries: many(stripeUsageDeliveries),
	}),
);

export const stripeUsageDeliveryRelations = relations(
	stripeUsageDeliveries,
	({ one }) => ({
		meter: one(stripeUsageMeters, {
			fields: [stripeUsageDeliveries.stripeUsageMeterId],
			references: [stripeUsageMeters.stripeUsageMeterId],
		}),
		usageEvent: one(usageEvents, {
			fields: [stripeUsageDeliveries.usageEventId],
			references: [usageEvents.usageEventId],
		}),
	}),
);

export type PlatformObservabilityBackend =
	typeof platformObservabilityBackends.$inferSelect;
export type OrganizationObservabilityPolicy =
	typeof organizationObservabilityPolicies.$inferSelect;
export type StripeUsageMeter = typeof stripeUsageMeters.$inferSelect;
