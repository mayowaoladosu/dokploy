import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
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
import { applications } from "./application";
import { deployments } from "./deployment";
import { environments } from "./environment";
import { projects } from "./project";

export const usageMetric = pgEnum("usageMetric", [
	"build_seconds",
	"cpu_milliseconds",
	"memory_byte_seconds",
	"request_count",
	"egress_bytes",
	"storage_byte_hours",
]);

export const usageSource = pgEnum("usageSource", [
	"build",
	"runtime",
	"edge",
	"storage",
	"manual",
]);

export const usageQuotaWindow = pgEnum("usageQuotaWindow", [
	"hour",
	"day",
	"month",
]);

export const usageQuotaAction = pgEnum("usageQuotaAction", [
	"warn",
	"block",
	"throttle",
]);

export const usageEvents = pgTable(
	"usage_event",
	{
		usageEventId: text("usage_event_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		idempotencyKey: text("idempotency_key").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("project_id").references(() => projects.projectId, {
			onDelete: "set null",
		}),
		environmentId: text("environment_id").references(
			() => environments.environmentId,
			{ onDelete: "set null" },
		),
		applicationId: text("application_id").references(
			() => applications.applicationId,
			{ onDelete: "set null" },
		),
		deploymentId: text("deployment_id").references(
			() => deployments.deploymentId,
			{ onDelete: "set null" },
		),
		metric: usageMetric("metric").notNull(),
		source: usageSource("source").notNull(),
		quantity: bigint("quantity", { mode: "bigint" }).notNull(),
		unit: text("unit").notNull(),
		costMicros: bigint("cost_micros", { mode: "bigint" }),
		periodStart: timestamp("period_start").notNull(),
		periodEnd: timestamp("period_end").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("usageEvent_idempotencyKey_unique").on(table.idempotencyKey),
		index("usageEvent_organizationMetricPeriod_idx").on(
			table.organizationId,
			table.metric,
			table.periodStart,
		),
		index("usageEvent_applicationPeriod_idx").on(
			table.applicationId,
			table.periodStart,
		),
	],
);

export const usageQuotas = pgTable(
	"usage_quota",
	{
		usageQuotaId: text("usage_quota_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		metric: usageMetric("metric").notNull(),
		window: usageQuotaWindow("window").notNull(),
		limitQuantity: bigint("limit_quantity", { mode: "bigint" }).notNull(),
		action: usageQuotaAction("action").notNull().default("block"),
		enabled: boolean("enabled").notNull().default(true),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("usageQuota_organizationMetricWindow_unique").on(
			table.organizationId,
			table.metric,
			table.window,
		),
		index("usageQuota_organizationEnabled_idx").on(
			table.organizationId,
			table.enabled,
		),
	],
);

export const usageEventRelations = relations(usageEvents, ({ one }) => ({
	organization: one(organization, {
		fields: [usageEvents.organizationId],
		references: [organization.id],
	}),
	project: one(projects, {
		fields: [usageEvents.projectId],
		references: [projects.projectId],
	}),
	environment: one(environments, {
		fields: [usageEvents.environmentId],
		references: [environments.environmentId],
	}),
	application: one(applications, {
		fields: [usageEvents.applicationId],
		references: [applications.applicationId],
	}),
	deployment: one(deployments, {
		fields: [usageEvents.deploymentId],
		references: [deployments.deploymentId],
	}),
}));

export const usageQuotaRelations = relations(usageQuotas, ({ one }) => ({
	organization: one(organization, {
		fields: [usageQuotas.organizationId],
		references: [organization.id],
	}),
}));

export type UsageEvent = typeof usageEvents.$inferSelect;
export type UsageQuota = typeof usageQuotas.$inferSelect;
export type UsageMetric = UsageEvent["metric"];
