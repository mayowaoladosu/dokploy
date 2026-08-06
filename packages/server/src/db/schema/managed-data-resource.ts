import { relations } from "drizzle-orm";
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
import { environments } from "./environment";
import { platformRegions } from "./platform-infrastructure";
import { projects } from "./project";
import { encryptedText } from "./utils";

export const managedDataKind = pgEnum("managedDataKind", [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);

export const managedDataStatus = pgEnum("managedDataStatus", [
	"provisioning",
	"ready",
	"error",
	"deleting",
	"deleted",
	"restoring",
]);

export const managedDataResources = pgTable(
	"managed_data_resource",
	{
		managedDataResourceId: text("managed_data_resource_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "restrict" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.projectId, { onDelete: "restrict" }),
		environmentId: text("environment_id")
			.notNull()
			.references(() => environments.environmentId, { onDelete: "restrict" }),
		regionId: text("region_id").references(() => platformRegions.regionId, {
			onDelete: "set null",
		}),
		provider: text("provider").notNull(),
		providerResourceId: text("provider_resource_id"),
		kind: managedDataKind("kind").notNull(),
		status: managedDataStatus("status").notNull().default("provisioning"),
		name: text("name").notNull(),
		plan: text("plan").notNull(),
		storageLimitBytes: bigint("storage_limit_bytes", { mode: "bigint" }),
		retentionDays: integer("retention_days").notNull().default(7),
		pitrEnabled: boolean("pitr_enabled").notNull().default(true),
		highAvailability: boolean("high_availability").notNull().default(true),
		poolingEnabled: boolean("pooling_enabled").notNull().default(true),
		replicas: integer("replicas").notNull().default(2),
		backupEnabled: boolean("backup_enabled").notNull().default(true),
		backupIntervalHours: integer("backup_interval_hours").notNull().default(24),
		backupRetentionDays: integer("backup_retention_days").notNull().default(7),
		nextBackupAt: timestamp("next_backup_at"),
		lastBackupAt: timestamp("last_backup_at"),
		lifecycleAttempts: integer("lifecycle_attempts").notNull().default(0),
		nextReconcileAt: timestamp("next_reconcile_at").defaultNow().notNull(),
		credentialVersion: integer("credential_version").notNull().default(1),
		lastHealthyAt: timestamp("last_healthy_at"),
		deletionRequestedAt: timestamp("deletion_requested_at"),
		usageAttempts: integer("usage_attempts").notNull().default(0),
		nextUsageAt: timestamp("next_usage_at").defaultNow().notNull(),
		connectionUri: encryptedText("connection_uri"),
		errorMessage: text("error_message"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("managedDataResource_organizationIdempotency_unique").on(
			table.organizationId,
			table.idempotencyKey,
		),
		uniqueIndex("managedDataResource_providerResource_unique").on(
			table.provider,
			table.providerResourceId,
		),
		index("managedDataResource_organizationStatus_idx").on(
			table.organizationId,
			table.status,
		),
		index("managedDataResource_environment_idx").on(table.environmentId),
		index("managedDataResource_reconcile_idx").on(
			table.status,
			table.nextReconcileAt,
		),
		index("managedDataResource_usage_idx").on(table.status, table.nextUsageAt),
	],
);

export const managedDataResourceRelations = relations(
	managedDataResources,
	({ one }) => ({
		organization: one(organization, {
			fields: [managedDataResources.organizationId],
			references: [organization.id],
		}),
		project: one(projects, {
			fields: [managedDataResources.projectId],
			references: [projects.projectId],
		}),
		environment: one(environments, {
			fields: [managedDataResources.environmentId],
			references: [environments.environmentId],
		}),
		region: one(platformRegions, {
			fields: [managedDataResources.regionId],
			references: [platformRegions.regionId],
		}),
	}),
);

export type ManagedDataResource = typeof managedDataResources.$inferSelect;
export type ManagedDataKind = ManagedDataResource["kind"];
