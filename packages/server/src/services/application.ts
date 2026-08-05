import { docker, IS_MANAGED_PAAS } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type apiCreateApplication,
	applications,
	buildAppName,
	environments,
} from "@dokploy/server/db/schema";
import { getAdvancedStats } from "@dokploy/server/monitoring/utils";
import { sendBuildErrorNotifications } from "@dokploy/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@dokploy/server/utils/notifications/build-success";
import { getGitCommitInfo } from "@dokploy/server/utils/providers/git";
import { createTraefikConfig } from "@dokploy/server/utils/traefik/application";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import type { z } from "zod";
import { getDokployUrl } from "./admin";
import {
	createDeployment,
	createDeploymentPreview,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { appendDeploymentFailureLog } from "./deployment-log";
import { type Domain, getDomainHost } from "./domain";
import {
	createPreviewDeploymentComment,
	getIssueComment,
	issueCommentExists,
	updateIssueComment,
} from "./github";
import {
	assertManagedResourceLimits,
	getManagedResourceDefaults,
	resolveManagedCompute,
} from "./platform";
import {
	ensureApplicationPlatformPlacement,
	updatePlatformPlacementReplicas,
} from "./platform-infrastructure";
import { createPlatformReleasePlan } from "./platform-release-orchestrator";
import {
	findPreviewDeploymentById,
	updatePreviewDeployment,
} from "./preview-deployment";
import { validUniqueServerAppName } from "./project";
import { ReleaseConflictError } from "./release-state-machine";
export type Application = typeof applications.$inferSelect;

export const createApplication = async (
	input: z.infer<typeof apiCreateApplication>,
) => {
	const appName = buildAppName("app", input.appName);
	const compute = await resolveManagedCompute({
		kind: "application",
		requestedServerId: input.serverId,
	});

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Application with this 'AppName' already exists",
		});
	}

	const newApplication = await db.transaction(async (tx) => {
		const newApplication = await tx
			.insert(applications)
			.values({
				...input,
				...compute,
				...getManagedResourceDefaults(),
				appName,
				...(IS_MANAGED_PAAS ? { buildType: "railpack" as const } : {}),
			})
			.returning()
			.then((value) => value[0]);

		if (!newApplication) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the application",
			});
		}

		if (process.env.NODE_ENV === "development") {
			createTraefikConfig(newApplication.appName);
		}

		return newApplication;
	});

	if (IS_MANAGED_PAAS) {
		try {
			const environment = await db.query.environments.findFirst({
				where: eq(environments.environmentId, newApplication.environmentId),
				with: { project: { columns: { organizationId: true } } },
			});
			if (!environment) {
				throw new Error("Application environment was not found");
			}
			const placement = await ensureApplicationPlatformPlacement({
				applicationId: newApplication.applicationId,
				organizationId: environment.project.organizationId,
				desiredReplicas: newApplication.replicas,
			});
			if (!newApplication.serverId && !placement) {
				throw new Error("Managed Kubernetes capacity changed during placement");
			}
		} catch (error) {
			await db
				.delete(applications)
				.where(eq(applications.applicationId, newApplication.applicationId));
			throw error;
		}
	}

	return newApplication;
};

export const findApplicationById = async (applicationId: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
		with: {
			environment: { with: { project: true } },
			domains: true,
			deployments: true,
			mounts: true,
			redirects: true,
			security: true,
			ports: true,
			gitlab: {
				columns: { secret: false, accessToken: false, refreshToken: false },
			},
			github: {
				columns: {
					githubClientSecret: false,
					githubPrivateKey: false,
					githubWebhookSecret: false,
				},
			},
			bitbucket: { columns: { appPassword: false, apiToken: false } },
			gitea: {
				columns: {
					clientSecret: false,
					accessToken: false,
					refreshToken: false,
				},
			},
			server: true,
			previewDeployments: true,
			registry: { columns: { password: false } },
			buildRegistry: { columns: { password: false } },
			rollbackRegistry: { columns: { password: false } },
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Application not found",
		});
	}
	return application;
};

export const findApplicationByName = async (appName: string) => {
	const application = await db.query.applications.findFirst({
		where: eq(applications.appName, appName),
	});

	return application;
};

export const updateApplication = async (
	applicationId: string,
	applicationData: Partial<Application>,
) => {
	assertManagedResourceLimits(applicationData);
	const { appName, ...rest } = applicationData;
	const application = await db
		.update(applications)
		.set({
			...rest,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();
	if (applicationData.replicas !== undefined) {
		await updatePlatformPlacementReplicas(
			applicationId,
			applicationData.replicas,
		);
	}

	return application[0];
};

export const updateApplicationStatus = async (
	applicationId: string,
	applicationStatus: Application["applicationStatus"],
) => {
	const application = await db
		.update(applications)
		.set({
			applicationStatus: applicationStatus,
		})
		.where(eq(applications.applicationId, applicationId))
		.returning();

	return application;
};

export const deployApplication = async ({
	applicationId,
	titleLog = "Manual deployment",
	descriptionLog = "",
	deploymentId,
	signal,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	deploymentId?: string;
	signal?: AbortSignal;
}) => {
	const application = await findApplicationById(applicationId);
	const serverId = application.buildServerId || application.serverId;
	const releasePlan = await createPlatformReleasePlan(application);

	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;
	const deployment = await createDeployment(
		{
			applicationId: applicationId,
			title: titleLog,
			description: descriptionLog,
		},
		{ deploymentId },
	);

	try {
		await releasePlan.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "deploy" },
			signal,
		});
		signal?.throwIfAborted();
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof ReleaseConflictError) throw error;
		await appendDeploymentFailureLog({
			error,
			logPath: deployment.logPath,
			serverId,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");

		await sendBuildErrorNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: application.environment.project.organizationId,
		});

		throw error;
	} finally {
		// Only extract commit info for non-docker sources
		if (!signal?.aborted && application.sourceType !== "docker") {
			const commitInfo = await getGitCommitInfo({
				appName: application.appName,
				type: "application",
				serverId: serverId,
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
	return true;
};

export const rebuildApplication = async ({
	applicationId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
	deploymentId,
	signal,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	deploymentId?: string;
	signal?: AbortSignal;
}) => {
	const application = await findApplicationById(applicationId);
	const serverId = application.buildServerId || application.serverId;
	const buildLink = `${await getDokployUrl()}/dashboard/project/${application.environment.projectId}/environment/${application.environmentId}/services/application/${application.applicationId}?tab=deployments`;

	const deployment = await createDeployment(
		{
			applicationId: applicationId,
			title: titleLog,
			description: descriptionLog,
		},
		{ deploymentId },
	);

	try {
		const releasePlan = await createPlatformReleasePlan(application);
		await releasePlan.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "rebuild" },
			signal,
		});
		signal?.throwIfAborted();
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(applicationId, "done");

		await sendBuildSuccessNotifications({
			projectName: application.environment.project.name,
			applicationName: application.name,
			applicationType: "application",
			buildLink,
			organizationId: application.environment.project.organizationId,
			domains: application.domains,
			environmentName: application.environment.name,
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof ReleaseConflictError) throw error;
		await appendDeploymentFailureLog({
			error,
			logPath: deployment.logPath,
			serverId,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateApplicationStatus(applicationId, "error");
		throw error;
	}

	return true;
};

export const deployPreviewApplication = async ({
	applicationId,
	titleLog = "Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
	deploymentId,
	signal,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
	deploymentId?: string;
	signal?: AbortSignal;
}) => {
	const application = await findApplicationById(applicationId);
	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);
	if (!previewDeployment.domain) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Preview domain is not ready",
		});
	}
	const deployment = await createDeploymentPreview(
		{
			title: titleLog,
			description: descriptionLog,
			previewDeploymentId: previewDeploymentId,
		},
		{ deploymentId },
	);

	await updatePreviewDeployment(previewDeploymentId, {
		createdAt: new Date().toISOString(),
	});

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};
	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}
		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${buildingComment}`,
		});
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.rollbackActive = false;
		application.buildRegistry = null;
		application.rollbackRegistry = null;
		application.registry = null;
		application.branch = previewDeployment.branch;
		const releasePlan = await createPlatformReleasePlan(application);
		await releasePlan.orchestrator.execute({
			application: {
				...application,
				releaseIdentity: previewDeployment.previewDeploymentId,
				releaseDomains: [
					{
						host: previewDeployment.domain.host,
						https: previewDeployment.domain.https,
						path: previewDeployment.domain.path,
					},
				],
			},
			deployment,
			intent: {
				kind: "preview-deploy",
				sourceApplicationId: applicationId,
			},
			signal,
		});
		signal?.throwIfAborted();
		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof ReleaseConflictError) throw error;
		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const rebuildPreviewApplication = async ({
	applicationId,
	titleLog = "Rebuild Preview Deployment",
	descriptionLog = "",
	previewDeploymentId,
	deploymentId,
	signal,
}: {
	applicationId: string;
	titleLog: string;
	descriptionLog: string;
	previewDeploymentId: string;
	deploymentId?: string;
	signal?: AbortSignal;
}) => {
	const application = await findApplicationById(applicationId);
	const previewDeployment =
		await findPreviewDeploymentById(previewDeploymentId);
	if (!previewDeployment.domain) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Preview domain is not ready",
		});
	}

	const deployment = await createDeploymentPreview(
		{
			title: titleLog,
			description: descriptionLog,
			previewDeploymentId: previewDeploymentId,
		},
		{ deploymentId },
	);

	const previewDomain = getDomainHost(previewDeployment?.domain as Domain);
	const issueParams = {
		owner: application?.owner || "",
		repository: application?.repository || "",
		issue_number: previewDeployment.pullRequestNumber,
		comment_id: Number.parseInt(previewDeployment.pullRequestCommentId),
		githubId: application?.githubId || "",
	};

	try {
		const commentExists = await issueCommentExists({
			...issueParams,
		});
		if (!commentExists) {
			const result = await createPreviewDeploymentComment({
				...issueParams,
				previewDomain,
				appName: previewDeployment.appName,
				githubId: application?.githubId || "",
				previewDeploymentId,
			});

			if (!result) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Pull request comment not found",
				});
			}

			issueParams.comment_id = Number.parseInt(result?.pullRequestCommentId);
		}

		const buildingComment = getIssueComment(
			application.name,
			"running",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${buildingComment}`,
		});

		// Set application properties for preview deployment
		application.appName = previewDeployment.appName;
		application.env = `${application.previewEnv}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildArgs = `${application.previewBuildArgs}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.buildSecrets = `${application.previewBuildSecrets}\nDOKPLOY_DEPLOY_URL=${previewDeployment?.domain?.host}`;
		application.rollbackActive = false;
		application.buildRegistry = null;
		application.rollbackRegistry = null;
		application.registry = null;

		application.branch = previewDeployment.branch;
		const releasePlan = await createPlatformReleasePlan(application);
		await releasePlan.orchestrator.execute({
			application: {
				...application,
				releaseIdentity: previewDeployment.previewDeploymentId,
				releaseDomains: [
					{
						host: previewDeployment.domain.host,
						https: previewDeployment.domain.https,
						path: previewDeployment.domain.path,
					},
				],
			},
			deployment,
			intent: {
				kind: "preview-rebuild",
				sourceApplicationId: applicationId,
			},
			signal,
		});
		signal?.throwIfAborted();

		const successComment = getIssueComment(
			application.name,
			"success",
			previewDomain,
		);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${successComment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "done",
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof ReleaseConflictError) throw error;
		const serverId = application.buildServerId || application.serverId;
		await appendDeploymentFailureLog({
			error,
			logPath: deployment.logPath,
			serverId,
		});

		const comment = getIssueComment(application.name, "error", previewDomain);
		await updateIssueComment({
			...issueParams,
			body: `### Dokploy Preview Deployment\n\n${comment}`,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updatePreviewDeployment(previewDeploymentId, {
			previewStatus: "error",
		});
		throw error;
	}

	return true;
};

export const getApplicationStats = async (appName: string) => {
	if (appName === "dokploy") {
		return await getAdvancedStats(appName);
	}
	const filter = {
		status: ["running"],
		label: [`com.docker.swarm.service.name=${appName}`],
	};

	const containers = await docker.listContainers({
		filters: JSON.stringify(filter),
	});

	const container = containers[0];
	if (!container || container?.State !== "running") {
		return null;
	}

	const data = await getAdvancedStats(appName);

	return data;
};
