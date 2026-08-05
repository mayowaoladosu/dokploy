import { relations } from "drizzle-orm";
import {
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
import { buildArtifacts } from "./build-artifact";
import { deployments } from "./deployment";

export const releaseState = pgEnum("releaseState", [
	"queued",
	"preparing",
	"building",
	"artifact_ready",
	"scheduling",
	"verifying",
	"ready",
	"failed",
	"rolling_back",
	"rolled_back",
	"cancelled",
]);

export const releases = pgTable(
	"release",
	{
		releaseId: text("release_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		deploymentId: text("deployment_id")
			.notNull()
			.references(() => deployments.deploymentId, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		artifactId: text("artifact_id").references(
			() => buildArtifacts.artifactId,
			{ onDelete: "set null" },
		),
		previousArtifactId: text("previous_artifact_id").references(
			() => buildArtifacts.artifactId,
			{ onDelete: "set null" },
		),
		previousImageRef: text("previous_image_ref"),
		state: releaseState("state").notNull().default("queued"),
		stateVersion: integer("state_version").notNull().default(0),
		attempt: integer("attempt").notNull().default(1),
		runtimeProvider: text("runtime_provider").notNull().default("swarm"),
		errorMessage: text("error_message"),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		heartbeatAt: timestamp("heartbeat_at").defaultNow().notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
		finishedAt: timestamp("finished_at"),
	},
	(table) => [
		uniqueIndex("release_deploymentId_unique").on(table.deploymentId),
		index("release_applicationId_idx").on(table.applicationId),
		index("release_state_idx").on(table.state),
		index("release_heartbeatAt_idx").on(table.heartbeatAt),
	],
);

export const releaseRelations = relations(releases, ({ one }) => ({
	deployment: one(deployments, {
		fields: [releases.deploymentId],
		references: [deployments.deploymentId],
	}),
	application: one(applications, {
		fields: [releases.applicationId],
		references: [applications.applicationId],
	}),
	artifact: one(buildArtifacts, {
		fields: [releases.artifactId],
		references: [buildArtifacts.artifactId],
		relationName: "releaseArtifact",
	}),
	previousArtifact: one(buildArtifacts, {
		fields: [releases.previousArtifactId],
		references: [buildArtifacts.artifactId],
		relationName: "releasePreviousArtifact",
	}),
}));

export type Release = typeof releases.$inferSelect;
export type ReleaseState = Release["state"];
