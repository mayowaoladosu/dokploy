import { db } from "@dokploy/server/db";
import {
	deployments,
	type GitDelivery,
	type GitDeliveryMetadata,
	type GitDeliveryTarget,
	gitBranchEnvironmentMappings,
	gitDeliveries,
	gitDeliveryTargets,
	type PersistedGitDeliveryJob,
	releases,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { GitWebhookProvider } from "./git-webhook";

export type GitDeliveryTargetPlan = {
	targetKey: string;
	applicationId?: string;
	composeId?: string;
	previewDeploymentId?: string;
	job: PersistedGitDeliveryJob;
	targetName: string;
	detailsUrl?: string;
	externalCommentId?: string;
};

export type AdmitGitDeliveryInput = {
	organizationId: string;
	gitProviderId?: string;
	providerConnectionId?: string;
	provider: GitWebhookProvider;
	providerScopeHash: string;
	providerDeliveryId: string;
	eventType: string;
	repositoryOwner?: string;
	repositoryName?: string;
	branch?: string;
	commitSha?: string;
	commitMessage?: string;
	payloadHash: string;
	metadata?: GitDeliveryMetadata;
	targets: GitDeliveryTargetPlan[];
};

const terminalTargetStatuses = [
	"succeeded",
	"failed",
	"cancelled",
	"ignored",
] as const;

const retryAt = (attempts: number, maximumMs = 15 * 60_000) =>
	new Date(
		Date.now() + Math.min(2 ** Math.min(attempts, 10) * 1_000, maximumMs),
	);

const requestGitDeliveryReport = () => ({
	reportStatus: sql`
		case
			when ${gitDeliveryTargets.reportStatus} = 'syncing' then ${gitDeliveryTargets.reportStatus}
			else 'pending'::"gitDeliveryReportStatus"
		end
	`,
	nextReportAt: sql`
		case
			when ${gitDeliveryTargets.reportStatus} = 'syncing' then ${gitDeliveryTargets.nextReportAt}
			else now()
		end
	`,
});

export const admitGitDelivery = async (input: AdmitGitDeliveryInput) =>
	db.transaction(async (tx) => {
		const lockName = `vlyv:git-delivery:${input.organizationId}:${input.provider}:${input.providerScopeHash}:${input.providerDeliveryId}`;
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`,
		);
		const existing = await tx.query.gitDeliveries.findFirst({
			where: and(
				eq(gitDeliveries.organizationId, input.organizationId),
				eq(gitDeliveries.provider, input.provider),
				eq(gitDeliveries.providerScopeHash, input.providerScopeHash),
				eq(gitDeliveries.providerDeliveryId, input.providerDeliveryId),
			),
			with: { targets: true },
		});
		if (existing) {
			if (existing.payloadHash !== input.payloadHash) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Webhook delivery identity was reused with another payload",
				});
			}
			return { delivery: existing, targets: existing.targets, duplicate: true };
		}

		const [delivery] = await tx
			.insert(gitDeliveries)
			.values({
				organizationId: input.organizationId,
				gitProviderId: input.gitProviderId,
				providerConnectionId: input.providerConnectionId,
				provider: input.provider,
				providerScopeHash: input.providerScopeHash,
				providerDeliveryId: input.providerDeliveryId,
				eventType: input.eventType,
				repositoryOwner: input.repositoryOwner,
				repositoryName: input.repositoryName,
				branch: input.branch,
				commitSha: input.commitSha,
				commitMessage: input.commitMessage,
				payloadHash: input.payloadHash,
				signatureVerified: true,
				status: input.targets.length > 0 ? "accepted" : "ignored",
				processedAt: input.targets.length > 0 ? null : new Date(),
				metadata: input.metadata ?? {},
			})
			.returning();
		if (!delivery) throw new Error("Failed to persist Git delivery");

		const targets =
			input.targets.length === 0
				? []
				: await tx
						.insert(gitDeliveryTargets)
						.values(
							input.targets.map((target) => ({
								gitDeliveryId: delivery.gitDeliveryId,
								targetKey: target.targetKey,
								applicationId: target.applicationId,
								composeId: target.composeId,
								previewDeploymentId: target.previewDeploymentId,
								job: target.job,
								targetName: target.targetName,
								detailsUrl: target.detailsUrl,
								externalCommentId: target.externalCommentId,
							})),
						)
						.returning();
		return { delivery, targets, duplicate: false };
	});

export const findGitDeliveryTarget = async (gitDeliveryTargetId: string) => {
	const target = await db.query.gitDeliveryTargets.findFirst({
		where: eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
		with: {
			delivery: true,
			application: {
				with: {
					environment: { with: { project: true } },
				},
			},
			compose: true,
			previewDeployment: true,
		},
	});
	if (!target) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git delivery target not found",
		});
	}
	return target;
};

export const prepareGitDeliveryTargetForEnqueue = async (
	gitDeliveryTargetId: string,
	now = new Date(),
) =>
	db.transaction(async (tx) => {
		const lockName = `vlyv:git-delivery-target:${gitDeliveryTargetId}`;
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`,
		);
		const target = await tx.query.gitDeliveryTargets.findFirst({
			where: and(
				eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
				inArray(gitDeliveryTargets.status, ["pending", "enqueued"]),
			),
		});
		if (
			!target ||
			terminalTargetStatuses.includes(
				target.status as (typeof terminalTargetStatuses)[number],
			) ||
			target.status === "running" ||
			target.nextAttemptAt > now
		) {
			return null;
		}
		const attempts = target.attempts + 1;
		const [claimed] = await tx
			.update(gitDeliveryTargets)
			.set({
				status: "enqueued",
				attempts,
				nextAttemptAt: new Date(now.getTime() + 10 * 60_000),
				errorMessage: null,
				updatedAt: now,
			})
			.where(eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId))
			.returning();
		return claimed ?? null;
	});

export const markGitDeliveryTargetEnqueued = async (
	gitDeliveryTargetId: string,
	workflowId: string,
) => {
	await db
		.update(gitDeliveryTargets)
		.set({
			status: "enqueued",
			workflowId,
			enqueuedAt: new Date(),
			nextAttemptAt: new Date(Date.now() + 10 * 60_000),
			...requestGitDeliveryReport(),
			errorMessage: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
				inArray(gitDeliveryTargets.status, ["pending", "enqueued"]),
			),
		);
};

export const markGitDeliveryTargetEnqueueFailed = async (
	gitDeliveryTargetId: string,
	error: unknown,
) => {
	const target = await db.query.gitDeliveryTargets.findFirst({
		where: eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
	});
	if (!target) return;
	if (
		terminalTargetStatuses.includes(
			target.status as (typeof terminalTargetStatuses)[number],
		)
	) {
		return;
	}
	await db
		.update(gitDeliveryTargets)
		.set({
			status: target.attempts >= 20 ? "failed" : "pending",
			nextAttemptAt: retryAt(target.attempts),
			errorMessage:
				error instanceof Error
					? error.message.slice(0, 1_000)
					: "Git delivery enqueue failed",
			...requestGitDeliveryReport(),
			finishedAt: target.attempts >= 20 ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
				inArray(gitDeliveryTargets.status, ["pending", "enqueued"]),
			),
		);
	await refreshGitDeliveryStatus(target.gitDeliveryId);
};

export const markGitDeliveryTargetRunning = async (
	gitDeliveryTargetId?: string,
) => {
	if (!gitDeliveryTargetId) return;
	await db
		.update(gitDeliveryTargets)
		.set({
			status: "running",
			startedAt: new Date(),
			nextAttemptAt: new Date(Date.now() + 60_000),
			...requestGitDeliveryReport(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
				inArray(gitDeliveryTargets.status, ["pending", "enqueued", "running"]),
			),
		);
};

export const markGitDeliveryTargetFinished = async (
	gitDeliveryTargetId: string | undefined,
	status: "succeeded" | "failed" | "cancelled" | "ignored",
	error?: unknown,
) => {
	if (!gitDeliveryTargetId) return;
	const [target] = await db
		.update(gitDeliveryTargets)
		.set({
			status,
			errorMessage:
				status === "failed"
					? error instanceof Error
						? error.message.slice(0, 1_000)
						: "Git delivery target failed"
					: null,
			finishedAt: new Date(),
			...requestGitDeliveryReport(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
				inArray(gitDeliveryTargets.status, ["pending", "enqueued", "running"]),
			),
		)
		.returning();
	if (target) await refreshGitDeliveryStatus(target.gitDeliveryId);
};

export const refreshGitDeliveryStatus = async (gitDeliveryId: string) => {
	const targets = await db.query.gitDeliveryTargets.findMany({
		where: eq(gitDeliveryTargets.gitDeliveryId, gitDeliveryId),
	});
	if (targets.length === 0) return;
	const allTerminal = targets.every((target) =>
		terminalTargetStatuses.includes(
			target.status as (typeof terminalTargetStatuses)[number],
		),
	);
	if (!allTerminal) {
		await db
			.update(gitDeliveries)
			.set({ status: "accepted", updatedAt: new Date() })
			.where(eq(gitDeliveries.gitDeliveryId, gitDeliveryId));
		return;
	}
	const failed = targets.some((target) =>
		["failed", "cancelled"].includes(target.status),
	);
	await db
		.update(gitDeliveries)
		.set({
			status: failed ? "failed" : "completed",
			errorMessage: failed ? "One or more delivery targets failed" : null,
			processedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(gitDeliveries.gitDeliveryId, gitDeliveryId));
};

export const listGitDeliveryTargetsDueForEnqueue = async (
	now = new Date(),
	limit = 100,
) =>
	db.query.gitDeliveryTargets.findMany({
		where: and(
			inArray(gitDeliveryTargets.status, ["pending", "enqueued"]),
			lte(gitDeliveryTargets.nextAttemptAt, now),
		),
		orderBy: [asc(gitDeliveryTargets.nextAttemptAt)],
		limit,
	});

export const reconcileGitDeliveryTargetStates = async (limit = 100) => {
	const targets = await db.query.gitDeliveryTargets.findMany({
		where: and(
			inArray(gitDeliveryTargets.status, ["enqueued", "running"]),
			lte(gitDeliveryTargets.nextAttemptAt, new Date()),
		),
		orderBy: [asc(gitDeliveryTargets.nextAttemptAt)],
		limit,
	});
	let reconciled = 0;
	for (const target of targets) {
		if (!target.workflowId) {
			await db
				.update(gitDeliveryTargets)
				.set({
					status: "pending",
					nextAttemptAt: new Date(),
					errorMessage: "Delivery workflow identity requires reconciliation",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(
							gitDeliveryTargets.gitDeliveryTargetId,
							target.gitDeliveryTargetId,
						),
						inArray(gitDeliveryTargets.status, ["enqueued", "running"]),
					),
				);
			reconciled += 1;
			continue;
		}
		const deployment = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, target.workflowId),
		});
		const release = await db.query.releases.findFirst({
			where: eq(releases.deploymentId, target.workflowId),
		});
		const status =
			deployment?.status === "done" || release?.state === "ready"
				? "succeeded"
				: deployment?.status === "cancelled" || release?.state === "cancelled"
					? "cancelled"
					: deployment?.status === "error" ||
							["failed", "rolled_back"].includes(release?.state ?? "")
						? "failed"
						: null;
		if (status) {
			await markGitDeliveryTargetFinished(
				target.gitDeliveryTargetId,
				status,
				deployment?.errorMessage ?? release?.errorMessage,
			);
			reconciled += 1;
		} else if (deployment || release) {
			await db
				.update(gitDeliveryTargets)
				.set({
					status: "running",
					nextAttemptAt: new Date(Date.now() + 5 * 60_000),
					updatedAt: new Date(),
				})
				.where(
					eq(
						gitDeliveryTargets.gitDeliveryTargetId,
						target.gitDeliveryTargetId,
					),
				);
		} else if (target.status === "running") {
			await db
				.update(gitDeliveryTargets)
				.set({
					status: "pending",
					nextAttemptAt: new Date(),
					errorMessage: "Delivery worker stopped before deployment admission",
					updatedAt: new Date(),
				})
				.where(
					eq(
						gitDeliveryTargets.gitDeliveryTargetId,
						target.gitDeliveryTargetId,
					),
				);
		}
	}
	return reconciled;
};

export const markGitDeliveryReportSynced = async (
	gitDeliveryTargetId: string,
	input: {
		externalCheckId?: string;
		externalCommentId?: string;
		observedStatus: GitDeliveryTarget["status"];
	},
) => {
	await db.transaction(async (tx) => {
		const lockName = `vlyv:git-delivery-report:${gitDeliveryTargetId}`;
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`,
		);
		const current = await tx.query.gitDeliveryTargets.findFirst({
			where: eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
		});
		if (!current) return;
		const stateChanged = current.status !== input.observedStatus;
		await tx
			.update(gitDeliveryTargets)
			.set({
				reportStatus: stateChanged ? "pending" : "synced",
				externalCheckId: input.externalCheckId ?? current.externalCheckId,
				externalCommentId: input.externalCommentId ?? current.externalCommentId,
				reportErrorMessage: null,
				nextReportAt: stateChanged ? new Date() : current.nextReportAt,
				updatedAt: new Date(),
			})
			.where(eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId));
	});
};

export const prepareGitDeliveryTargetForReport = async (
	gitDeliveryTargetId: string,
	now = new Date(),
) =>
	db.transaction(async (tx) => {
		const lockName = `vlyv:git-delivery-report:${gitDeliveryTargetId}`;
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`,
		);
		const target = await tx.query.gitDeliveryTargets.findFirst({
			where: eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
		});
		if (
			!target ||
			!["pending", "syncing"].includes(target.reportStatus) ||
			target.nextReportAt > now
		) {
			return false;
		}
		await tx
			.update(gitDeliveryTargets)
			.set({
				reportStatus: "syncing",
				nextReportAt: new Date(now.getTime() + 10 * 60_000),
				updatedAt: now,
			})
			.where(eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId));
		return true;
	});

export const markGitDeliveryReportFailed = async (
	gitDeliveryTargetId: string,
	error: unknown,
) => {
	const target = await db.query.gitDeliveryTargets.findFirst({
		where: eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId),
	});
	if (!target) return;
	const reportAttempts = target.reportAttempts + 1;
	await db
		.update(gitDeliveryTargets)
		.set({
			reportStatus: reportAttempts >= 20 ? "failed" : "pending",
			reportAttempts,
			nextReportAt: retryAt(reportAttempts, 60 * 60_000),
			reportErrorMessage:
				error instanceof Error
					? error.message.slice(0, 1_000)
					: "Git status report failed",
			updatedAt: new Date(),
		})
		.where(eq(gitDeliveryTargets.gitDeliveryTargetId, gitDeliveryTargetId));
};

export const listGitDeliveryTargetsDueForReport = async (
	now = new Date(),
	limit = 100,
) =>
	db.query.gitDeliveryTargets.findMany({
		where: and(
			inArray(gitDeliveryTargets.reportStatus, ["pending", "syncing"]),
			lte(gitDeliveryTargets.nextReportAt, now),
		),
		orderBy: [asc(gitDeliveryTargets.nextReportAt)],
		limit,
	});

type BranchCandidate = {
	applicationId: string;
	environmentId: string;
	autoDeploy?: boolean | null;
	sourceType: string;
	branch?: string | null;
	gitlabBranch?: string | null;
	giteaBranch?: string | null;
	bitbucketBranch?: string | null;
	customGitBranch?: string | null;
	environment: {
		name: string;
		isDefault: boolean;
		projectId: string;
		project: { projectId: string; organizationId: string };
	};
};

const normalizedBranch = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

const configuredBranch = (application: BranchCandidate) =>
	application.sourceType === "github"
		? application.branch
		: application.sourceType === "gitlab"
			? application.gitlabBranch
			: application.sourceType === "gitea"
				? application.giteaBranch
				: application.sourceType === "bitbucket"
					? application.bitbucketBranch
					: application.customGitBranch;

export const classifyGitBranchEnvironmentMapping = ({
	configuredBranch,
	environmentName,
	isDefaultEnvironment,
	incomingBranch,
	autoDeploy,
}: {
	configuredBranch?: string | null;
	environmentName: string;
	isDefaultEnvironment: boolean;
	incomingBranch: string;
	autoDeploy: boolean;
}) => {
	const normalizedIncoming = normalizedBranch(incomingBranch);
	const automaticEnvironmentMatch =
		normalizedBranch(environmentName) === normalizedIncoming;
	const productionPromotion =
		isDefaultEnvironment &&
		["main", "master", "production"].includes(normalizedIncoming);
	return {
		matches:
			autoDeploy &&
			(configuredBranch === incomingBranch ||
				automaticEnvironmentMatch ||
				productionPromotion),
		isProduction: productionPromotion,
	};
};

export const resolveGitBranchEnvironmentMapping = async ({
	application,
	provider,
	repositoryOwner,
	repositoryName,
	branch,
}: {
	application: BranchCandidate;
	provider: GitWebhookProvider;
	repositoryOwner: string;
	repositoryName: string;
	branch: string;
}) => {
	const existing = await db.query.gitBranchEnvironmentMappings.findFirst({
		where: and(
			eq(gitBranchEnvironmentMappings.applicationId, application.applicationId),
			eq(gitBranchEnvironmentMappings.branch, branch),
		),
	});
	if (existing) return existing.autoDeploy ? existing : null;

	const classification = classifyGitBranchEnvironmentMapping({
		configuredBranch: configuredBranch(application),
		environmentName: application.environment.name,
		isDefaultEnvironment: application.environment.isDefault,
		incomingBranch: branch,
		autoDeploy: application.autoDeploy !== false,
	});
	if (!classification.matches) {
		return null;
	}

	const [mapping] = await db
		.insert(gitBranchEnvironmentMappings)
		.values({
			organizationId: application.environment.project.organizationId,
			projectId: application.environment.project.projectId,
			environmentId: application.environmentId,
			applicationId: application.applicationId,
			provider,
			repositoryOwner,
			repositoryName,
			branch,
			autoDeploy: true,
			isProduction: classification.isProduction,
		})
		.onConflictDoUpdate({
			target: [
				gitBranchEnvironmentMappings.applicationId,
				gitBranchEnvironmentMappings.branch,
			],
			set: {
				provider,
				repositoryOwner,
				repositoryName,
				environmentId: application.environmentId,
				isProduction: classification.isProduction,
				updatedAt: new Date(),
			},
		})
		.returning();
	return mapping ?? null;
};

export const gitDeliveryForTenant = (delivery: GitDelivery) => ({
	gitDeliveryId: delivery.gitDeliveryId,
	provider: delivery.provider,
	eventType: delivery.eventType,
	repositoryOwner: delivery.repositoryOwner,
	repositoryName: delivery.repositoryName,
	branch: delivery.branch,
	commitSha: delivery.commitSha,
	status: delivery.status,
	receivedAt: delivery.receivedAt,
	processedAt: delivery.processedAt,
});
