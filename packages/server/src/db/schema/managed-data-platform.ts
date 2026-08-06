import { relations, sql } from "drizzle-orm";
import {
	bigint,
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
import { managedDataKind, managedDataResources } from "./managed-data-resource";
import { platformObjectStorages } from "./platform-edge";
import { encryptedText } from "./utils";

export const managedDataProviderType = pgEnum("managedDataProviderType", [
	"neon",
	"upstash",
	"http",
]);

export const managedDataProviderStatus = pgEnum("managedDataProviderStatus", [
	"provisioning",
	"active",
	"error",
	"offline",
]);

export const managedDataBackupStatus = pgEnum("managedDataBackupStatus", [
	"pending",
	"creating",
	"ready",
	"restoring",
	"restored",
	"failed",
	"deleting",
	"deleted",
]);

export const managedDataBackupKind = pgEnum("managedDataBackupKind", [
	"provider_snapshot",
	"platform_archive",
]);

export const managedDataEncryptionMode = pgEnum("managedDataEncryptionMode", [
	"provider_kms",
	"platform_kms",
]);

export type ManagedDataProviderCapabilities = {
	highAvailability: boolean;
	pooling: boolean;
	pitr: boolean;
	backups: boolean;
	restore: boolean;
	credentialRotation: boolean;
	usage: boolean;
	encryptionAtRest: boolean;
	platformArchive: boolean;
};

export type ManagedDataProviderMetadata = {
	allowPrivateEndpoint?: boolean;
	allowInsecure?: boolean;
	healthPath?: string;
	defaultRegions?: Record<string, string>;
	planMappings?: Record<string, string>;
};

export const platformManagedDataProviders = pgTable(
	"platform_managed_data_provider",
	{
		managedDataProviderId: text("managed_data_provider_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		name: text("name").notNull(),
		type: managedDataProviderType("type").notNull(),
		status: managedDataProviderStatus("status")
			.notNull()
			.default("provisioning"),
		baseUrl: text("base_url").notNull(),
		credentials: encryptedText("credentials").notNull(),
		kinds: managedDataKind("kinds").array().notNull(),
		defaultKinds: managedDataKind("default_kinds")
			.array()
			.notNull()
			.default([]),
		capabilities: jsonb("capabilities")
			.$type<ManagedDataProviderCapabilities>()
			.notNull(),
		metadata: jsonb("metadata")
			.$type<ManagedDataProviderMetadata>()
			.notNull()
			.default({}),
		lastVerifiedAt: timestamp("last_verified_at"),
		errorMessage: text("error_message"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("platformManagedDataProvider_name_unique").on(table.name),
		index("platformManagedDataProvider_status_idx").on(table.status),
	],
);

export const managedDataBackups = pgTable(
	"managed_data_backup",
	{
		managedDataBackupId: text("managed_data_backup_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		managedDataResourceId: text("managed_data_resource_id")
			.notNull()
			.references(() => managedDataResources.managedDataResourceId, {
				onDelete: "cascade",
			}),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		kind: managedDataBackupKind("kind").notNull(),
		status: managedDataBackupStatus("status").notNull().default("pending"),
		providerBackupId: text("provider_backup_id"),
		objectStorageId: text("object_storage_id").references(
			() => platformObjectStorages.objectStorageId,
			{ onDelete: "set null" },
		),
		objectKey: text("object_key"),
		checksum: text("checksum"),
		sizeBytes: bigint("size_bytes", { mode: "bigint" }),
		encryptionMode: managedDataEncryptionMode("encryption_mode").notNull(),
		expiresAt: timestamp("expires_at"),
		readyAt: timestamp("ready_at"),
		restoredAt: timestamp("restored_at"),
		errorMessage: text("error_message"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("managedDataBackup_resourceIdempotency_unique").on(
			table.managedDataResourceId,
			table.idempotencyKey,
		),
		uniqueIndex("managedDataBackup_providerId_unique")
			.on(table.managedDataResourceId, table.providerBackupId)
			.where(sql`${table.providerBackupId} is not null`),
		index("managedDataBackup_resourceStatus_idx").on(
			table.managedDataResourceId,
			table.status,
		),
		index("managedDataBackup_expiry_idx").on(table.status, table.expiresAt),
		index("managedDataBackup_retry_idx").on(table.status, table.nextAttemptAt),
	],
);

export const managedDataBindings = pgTable(
	"managed_data_binding",
	{
		managedDataBindingId: text("managed_data_binding_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		managedDataResourceId: text("managed_data_resource_id")
			.notNull()
			.references(() => managedDataResources.managedDataResourceId, {
				onDelete: "cascade",
			}),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		environmentVariable: text("environment_variable")
			.notNull()
			.default("DATABASE_URL"),
		appliedCredentialVersion: integer("applied_credential_version")
			.notNull()
			.default(0),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("managedDataBinding_applicationVariable_unique").on(
			table.applicationId,
			table.environmentVariable,
		),
		uniqueIndex("managedDataBinding_resourceApplication_unique").on(
			table.managedDataResourceId,
			table.applicationId,
		),
		index("managedDataBinding_resource_idx").on(table.managedDataResourceId),
	],
);

export const platformManagedDataProviderRelations = relations(
	platformManagedDataProviders,
	() => ({}),
);

export const managedDataBackupRelations = relations(
	managedDataBackups,
	({ one }) => ({
		resource: one(managedDataResources, {
			fields: [managedDataBackups.managedDataResourceId],
			references: [managedDataResources.managedDataResourceId],
		}),
		storage: one(platformObjectStorages, {
			fields: [managedDataBackups.objectStorageId],
			references: [platformObjectStorages.objectStorageId],
		}),
	}),
);

export const managedDataBindingRelations = relations(
	managedDataBindings,
	({ one }) => ({
		resource: one(managedDataResources, {
			fields: [managedDataBindings.managedDataResourceId],
			references: [managedDataResources.managedDataResourceId],
		}),
		application: one(applications, {
			fields: [managedDataBindings.applicationId],
			references: [applications.applicationId],
		}),
	}),
);

export type PlatformManagedDataProvider =
	typeof platformManagedDataProviders.$inferSelect;
export type ManagedDataBackup = typeof managedDataBackups.$inferSelect;
