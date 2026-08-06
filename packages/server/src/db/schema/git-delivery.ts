import { relations, sql } from "drizzle-orm";
import {
	boolean,
	check,
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
import { compose } from "./compose";
import { environments } from "./environment";
import { gitProvider } from "./git-provider";
import { previewDeployments } from "./preview-deployments";
import { projects } from "./project";

export const gitDeliveryProvider = pgEnum("gitDeliveryProvider", [
	"github",
	"gitlab",
	"gitea",
	"bitbucket",
	"soft_serve",
	"docker",
	"generic",
]);

export const gitDeliveryStatus = pgEnum("gitDeliveryStatus", [
	"received",
	"accepted",
	"completed",
	"failed",
	"ignored",
]);

export const gitDeliveryTargetStatus = pgEnum("gitDeliveryTargetStatus", [
	"pending",
	"enqueued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
	"ignored",
]);

export const gitDeliveryReportStatus = pgEnum("gitDeliveryReportStatus", [
	"pending",
	"syncing",
	"synced",
	"failed",
]);

export type PersistedGitDeliveryJob =
	| {
			kind: "deployment";
			deployment: Record<string, unknown>;
	  }
	| {
			kind: "preview_cleanup";
			previewDeploymentId: string;
	  };

export type GitDeliveryMetadata = {
	pullRequestId?: string;
	pullRequestNumber?: number;
	pullRequestUrl?: string;
	pullRequestTitle?: string;
	action?: string;
	productionPromotion?: boolean;
	providerProjectId?: string;
};

export const gitDeliveries = pgTable(
	"git_delivery",
	{
		gitDeliveryId: text("git_delivery_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		gitProviderId: text("git_provider_id").references(
			() => gitProvider.gitProviderId,
			{ onDelete: "set null" },
		),
		providerConnectionId: text("provider_connection_id"),
		provider: gitDeliveryProvider("provider").notNull(),
		providerScopeHash: text("provider_scope_hash").notNull(),
		providerDeliveryId: text("provider_delivery_id").notNull(),
		eventType: text("event_type").notNull(),
		repositoryOwner: text("repository_owner"),
		repositoryName: text("repository_name"),
		branch: text("branch"),
		commitSha: text("commit_sha"),
		commitMessage: text("commit_message"),
		payloadHash: text("payload_hash").notNull(),
		signatureVerified: boolean("signature_verified").notNull(),
		status: gitDeliveryStatus("status").notNull().default("received"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
		errorMessage: text("error_message"),
		metadata: jsonb("metadata")
			.$type<GitDeliveryMetadata>()
			.notNull()
			.default({}),
		receivedAt: timestamp("received_at").defaultNow().notNull(),
		processedAt: timestamp("processed_at"),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("gitDelivery_scopeDelivery_unique").on(
			table.organizationId,
			table.provider,
			table.providerScopeHash,
			table.providerDeliveryId,
		),
		index("gitDelivery_statusRetry_idx").on(table.status, table.nextAttemptAt),
		index("gitDelivery_repository_idx").on(
			table.organizationId,
			table.provider,
			table.repositoryOwner,
			table.repositoryName,
		),
		check(
			"gitDelivery_signatureVerified_check",
			sql`${table.signatureVerified} = true`,
		),
	],
);

export const gitDeliveryTargets = pgTable(
	"git_delivery_target",
	{
		gitDeliveryTargetId: text("git_delivery_target_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		gitDeliveryId: text("git_delivery_id")
			.notNull()
			.references(() => gitDeliveries.gitDeliveryId, { onDelete: "cascade" }),
		targetKey: text("target_key").notNull(),
		applicationId: text("application_id").references(
			() => applications.applicationId,
			{ onDelete: "cascade" },
		),
		composeId: text("compose_id").references(() => compose.composeId, {
			onDelete: "cascade",
		}),
		previewDeploymentId: text("preview_deployment_id").references(
			() => previewDeployments.previewDeploymentId,
			{ onDelete: "set null" },
		),
		status: gitDeliveryTargetStatus("status").notNull().default("pending"),
		workflowId: text("workflow_id"),
		job: jsonb("job").$type<PersistedGitDeliveryJob>().notNull(),
		targetName: text("target_name").notNull(),
		detailsUrl: text("details_url"),
		externalCheckId: text("external_check_id"),
		externalCommentId: text("external_comment_id"),
		reportStatus: gitDeliveryReportStatus("report_status")
			.notNull()
			.default("pending"),
		reportAttempts: integer("report_attempts").notNull().default(0),
		nextReportAt: timestamp("next_report_at").defaultNow().notNull(),
		reportErrorMessage: text("report_error_message"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at").defaultNow().notNull(),
		errorMessage: text("error_message"),
		enqueuedAt: timestamp("enqueued_at"),
		startedAt: timestamp("started_at"),
		finishedAt: timestamp("finished_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("gitDeliveryTarget_deliveryTarget_unique").on(
			table.gitDeliveryId,
			table.targetKey,
		),
		index("gitDeliveryTarget_retry_idx").on(table.status, table.nextAttemptAt),
		index("gitDeliveryTarget_report_idx").on(
			table.reportStatus,
			table.nextReportAt,
		),
		index("gitDeliveryTarget_application_idx").on(table.applicationId),
		check(
			"gitDeliveryTarget_owner_check",
			sql`num_nonnulls(${table.applicationId}, ${table.composeId}, ${table.previewDeploymentId}) >= 1`,
		),
	],
);

export const gitBranchEnvironmentMappings = pgTable(
	"git_branch_environment_mapping",
	{
		gitBranchEnvironmentMappingId: text("git_branch_environment_mapping_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.projectId, { onDelete: "cascade" }),
		environmentId: text("environment_id")
			.notNull()
			.references(() => environments.environmentId, { onDelete: "cascade" }),
		applicationId: text("application_id")
			.notNull()
			.references(() => applications.applicationId, { onDelete: "cascade" }),
		provider: gitDeliveryProvider("provider").notNull(),
		repositoryOwner: text("repository_owner").notNull(),
		repositoryName: text("repository_name").notNull(),
		branch: text("branch").notNull(),
		autoDeploy: boolean("auto_deploy").notNull().default(true),
		isProduction: boolean("is_production").notNull().default(false),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("gitBranchMapping_applicationBranch_unique").on(
			table.applicationId,
			table.branch,
		),
		index("gitBranchMapping_lookup_idx").on(
			table.organizationId,
			table.provider,
			table.repositoryOwner,
			table.repositoryName,
			table.branch,
		),
		index("gitBranchMapping_environment_idx").on(table.environmentId),
	],
);

export const gitDeliveriesRelations = relations(
	gitDeliveries,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [gitDeliveries.organizationId],
			references: [organization.id],
		}),
		gitProvider: one(gitProvider, {
			fields: [gitDeliveries.gitProviderId],
			references: [gitProvider.gitProviderId],
		}),
		targets: many(gitDeliveryTargets),
	}),
);

export const gitDeliveryTargetsRelations = relations(
	gitDeliveryTargets,
	({ one }) => ({
		delivery: one(gitDeliveries, {
			fields: [gitDeliveryTargets.gitDeliveryId],
			references: [gitDeliveries.gitDeliveryId],
		}),
		application: one(applications, {
			fields: [gitDeliveryTargets.applicationId],
			references: [applications.applicationId],
		}),
		compose: one(compose, {
			fields: [gitDeliveryTargets.composeId],
			references: [compose.composeId],
		}),
		previewDeployment: one(previewDeployments, {
			fields: [gitDeliveryTargets.previewDeploymentId],
			references: [previewDeployments.previewDeploymentId],
		}),
	}),
);

export const gitBranchEnvironmentMappingsRelations = relations(
	gitBranchEnvironmentMappings,
	({ one }) => ({
		organization: one(organization, {
			fields: [gitBranchEnvironmentMappings.organizationId],
			references: [organization.id],
		}),
		project: one(projects, {
			fields: [gitBranchEnvironmentMappings.projectId],
			references: [projects.projectId],
		}),
		environment: one(environments, {
			fields: [gitBranchEnvironmentMappings.environmentId],
			references: [environments.environmentId],
		}),
		application: one(applications, {
			fields: [gitBranchEnvironmentMappings.applicationId],
			references: [applications.applicationId],
		}),
	}),
);

export type GitDelivery = typeof gitDeliveries.$inferSelect;
export type GitDeliveryTarget = typeof gitDeliveryTargets.$inferSelect;
export type GitBranchEnvironmentMapping =
	typeof gitBranchEnvironmentMappings.$inferSelect;
