import { relations } from "drizzle-orm";
import {
	index,
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
]);

export const managedDataResources = pgTable(
	"managed_data_resource",
	{
		managedDataResourceId: text("managed_data_resource_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		idempotencyKey: text("idempotency_key").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		environmentId: text("environment_id")
			.notNull()
			.references(() => environments.environmentId, { onDelete: "cascade" }),
		regionId: text("region_id").references(() => platformRegions.regionId, {
			onDelete: "set null",
		}),
		provider: text("provider").notNull(),
		providerResourceId: text("provider_resource_id"),
		kind: managedDataKind("kind").notNull(),
		status: managedDataStatus("status").notNull().default("provisioning"),
		name: text("name").notNull(),
		plan: text("plan").notNull(),
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
		uniqueIndex("managedDataResource_idempotencyKey_unique").on(
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
