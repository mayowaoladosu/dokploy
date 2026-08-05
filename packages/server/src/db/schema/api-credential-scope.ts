import { relations, sql } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { apikey, organization } from "./account";

export const apiCredentialScopes = pgTable(
	"api_credential_scope",
	{
		apiKeyId: text("api_key_id")
			.primaryKey()
			.references(() => apikey.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		permissions: text("permissions")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		projectIds: text("project_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		environmentIds: text("environment_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		serviceIds: text("service_ids")
			.array()
			.notNull()
			.default(sql`ARRAY[]::text[]`),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("apiCredentialScope_organizationId_idx").on(table.organizationId),
	],
);

export const apiCredentialScopeRelations = relations(
	apiCredentialScopes,
	({ one }) => ({
		apiKey: one(apikey, {
			fields: [apiCredentialScopes.apiKeyId],
			references: [apikey.id],
		}),
		organization: one(organization, {
			fields: [apiCredentialScopes.organizationId],
			references: [organization.id],
		}),
	}),
);

export type ApiCredentialScope = typeof apiCredentialScopes.$inferSelect;
