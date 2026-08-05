import { relations } from "drizzle-orm";
import {
	bigint,
	index,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { applications } from "./application";
import { deployments } from "./deployment";

export const buildArtifacts = pgTable(
	"build_artifact",
	{
		artifactId: text("artifact_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		deploymentId: text("deployment_id")
			.notNull()
			.references(() => deployments.deploymentId, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		imageId: text("image_id").notNull(),
		imageDigest: text("image_digest"),
		imageRef: text("image_ref").notNull(),
		imageSizeBytes: bigint("image_size_bytes", { mode: "number" }),
		builder: text("builder").notNull(),
		executor: text("executor").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("buildArtifact_deploymentId_unique").on(table.deploymentId),
		index("buildArtifact_applicationId_idx").on(table.applicationId),
		index("buildArtifact_imageDigest_idx").on(table.imageDigest),
	],
);

export const buildArtifactRelations = relations(buildArtifacts, ({ one }) => ({
	deployment: one(deployments, {
		fields: [buildArtifacts.deploymentId],
		references: [deployments.deploymentId],
	}),
	application: one(applications, {
		fields: [buildArtifacts.applicationId],
		references: [applications.applicationId],
	}),
}));

export type BuildArtifactRecord = typeof buildArtifacts.$inferSelect;
