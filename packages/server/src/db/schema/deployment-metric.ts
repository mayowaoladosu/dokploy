import { relations } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { applications } from "./application";
import { deployments } from "./deployment";

export const deploymentMetrics = pgTable(
	"deployment_metric",
	{
		metricId: text("metric_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		deploymentId: text("deployment_id")
			.notNull()
			.references(() => deployments.deploymentId, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		buildDurationMs: integer("build_duration_ms"),
		imageSizeBytes: bigint("image_size_bytes", { mode: "number" }),
		runtimeDurationMs: integer("runtime_duration_ms"),
		readinessDurationMs: integer("readiness_duration_ms"),
		healthCheckCount: integer("health_check_count").notNull().default(0),
		healthCheckPassCount: integer("health_check_pass_count")
			.notNull()
			.default(0),
		healthCheckFailCount: integer("health_check_fail_count")
			.notNull()
			.default(0),
		healthCheckLatencyMs: integer("health_check_latency_ms"),
		healthCheckCheckedAt: timestamp("health_check_checked_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("deploymentMetric_deploymentId_unique").on(table.deploymentId),
		index("deploymentMetric_applicationId_idx").on(table.applicationId),
	],
);

export const deploymentMetricRelations = relations(
	deploymentMetrics,
	({ one }) => ({
		deployment: one(deployments, {
			fields: [deploymentMetrics.deploymentId],
			references: [deployments.deploymentId],
		}),
		application: one(applications, {
			fields: [deploymentMetrics.applicationId],
			references: [applications.applicationId],
		}),
	}),
);

export type DeploymentMetric = typeof deploymentMetrics.$inferSelect;
