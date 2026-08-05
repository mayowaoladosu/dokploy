import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type apiCreatePreviewDeployment,
	deployments,
	organization,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";
import { generatePassword } from "../templates";
import { removeDirectoryCode } from "../utils/filesystem/directory";
import { authGithub } from "../utils/providers/github";
import { manageDomain } from "../utils/traefik/domain";
import { findApplicationById } from "./application";
import { removeDeploymentsByPreviewDeploymentId } from "./deployment";
import { createDomain } from "./domain";
import { findGithubById, getIssueComment } from "./github";
import { getManagedApplicationDomain } from "./platform";
import { findApplicationPlatformPlacement } from "./platform-infrastructure";
import { createPlatformReleasePlan } from "./platform-release-orchestrator";
import { getWebServerSettings } from "./web-server-settings";

export type PreviewDeployment = typeof previewDeployments.$inferSelect;

export const buildPreviewAppName = (
	applicationName: string,
	suffix: string,
) => {
	const candidate = `preview-${applicationName}-${suffix}`
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (candidate.length <= 63) return candidate;
	const digest = createHash("sha256")
		.update(candidate)
		.digest("hex")
		.slice(0, 10);
	return `${candidate.slice(0, 63 - digest.length - 1).replace(/-+$/g, "")}-${digest}`;
};

export const findPreviewDeploymentById = async (
	previewDeploymentId: string,
) => {
	const application = await db.query.previewDeployments.findFirst({
		where: eq(previewDeployments.previewDeploymentId, previewDeploymentId),
		with: {
			domain: true,
			application: {
				columns: {
					applicationId: true,
					serverId: true,
				},
			},
		},
	});
	if (!application) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Preview Deployment not found",
		});
	}
	return application;
};

export const removePreviewDeployment = async (previewDeploymentId: string) => {
	try {
		const previewDeployment =
			await findPreviewDeploymentById(previewDeploymentId);
		const application = await findApplicationById(
			previewDeployment.applicationId,
		);

		application.appName = previewDeployment.appName;
		const releasePlan = await createPlatformReleasePlan(application);
		await releasePlan.orchestrator.remove({
			application: {
				...application,
				releaseIdentity: previewDeployment.previewDeploymentId,
				releaseDomains: previewDeployment.domain
					? [
							{
								host: previewDeployment.domain.host,
								https: previewDeployment.domain.https,
								path: previewDeployment.domain.path,
							},
						]
					: [],
			},
		});
		const cleanupOperations = [
			async () =>
				await removeDeploymentsByPreviewDeploymentId(
					previewDeployment,
					application?.serverId,
				),
			async () =>
				await removeDirectoryCode(application?.appName, application?.serverId),
		];
		for (const operation of cleanupOperations) {
			try {
				await operation();
			} catch (error) {
				console.error(error);
			}
		}
		await db
			.delete(previewDeployments)
			.where(eq(previewDeployments.previewDeploymentId, previewDeploymentId))
			.returning();
		return previewDeployment;
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Error deleting this preview deployment";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};
// testing-tesoitnmg-ddq0ul-preview-ihl44o
export const updatePreviewDeployment = async (
	previewDeploymentId: string,
	previewDeploymentData: Partial<PreviewDeployment>,
) => {
	const application = await db
		.update(previewDeployments)
		.set({
			...previewDeploymentData,
		})
		.where(eq(previewDeployments.previewDeploymentId, previewDeploymentId))
		.returning();

	return application;
};

export const findPreviewDeploymentsByApplicationId = async (
	applicationId: string,
) => {
	const deploymentsList = await db.query.previewDeployments.findMany({
		where: eq(previewDeployments.applicationId, applicationId),
		orderBy: desc(previewDeployments.createdAt),
		with: {
			deployments: {
				orderBy: desc(deployments.createdAt),
			},
			domain: true,
		},
	});
	return deploymentsList;
};

export const createPreviewDeployment = async (
	schema: z.infer<typeof apiCreatePreviewDeployment>,
) => {
	const application = await findApplicationById(schema.applicationId);
	const appName = buildPreviewAppName(application.appName, generatePassword(6));
	const managedDomain = getManagedApplicationDomain(appName);

	const org = await db.query.organization.findFirst({
		where: eq(organization.id, application.environment.project.organizationId),
	});
	const generateDomain =
		managedDomain ||
		(await generateWildcardDomain(
			application.previewWildcard || "*.sslip.io",
			appName,
			application.server?.ipAddress || "",
			org?.ownerId || "",
		));
	const previewHttps = Boolean(managedDomain) || application.previewHttps;

	if (!application.githubId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Github Account not configured correctly",
		});
	}

	// `findApplicationById` redacts `githubPrivateKey` from the `github`
	// relation, so the provider must be refetched to authenticate.
	const githubProvider = await findGithubById(application.githubId);
	const octokit = authGithub(githubProvider);

	const runningComment = getIssueComment(
		application.name,
		"initializing",
		`${previewHttps ? "https" : "http"}://${generateDomain}`,
	);

	const issue = await octokit.rest.issues.createComment({
		owner: application?.owner || "",
		repo: application?.repository || "",
		issue_number: Number.parseInt(schema.pullRequestNumber),
		body: `### Dokploy Preview Deployment\n\n${runningComment}`,
	});

	const previewDeployment = await db
		.insert(previewDeployments)
		.values({
			...schema,
			appName: appName,
			pullRequestCommentId: `${issue.data.id}`,
		})
		.returning()
		.then((value) => value[0]);

	if (!previewDeployment) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the preview deployment",
		});
	}

	const newDomain = await createDomain({
		host: generateDomain,
		path: application.previewPath,
		port: application.previewPort,
		https: previewHttps,
		certificateType: managedDomain
			? "letsencrypt"
			: application.previewCertificateType,
		customCertResolver: application.previewCustomCertResolver,
		domainType: "preview",
		previewDeploymentId: previewDeployment.previewDeploymentId,
	});

	application.appName = appName;
	const placement = await findApplicationPlatformPlacement(
		application.applicationId,
	);
	if (!placement || placement.runtimeTarget.runtime !== "kubernetes") {
		await manageDomain(application, newDomain);
	}

	await db
		.update(previewDeployments)
		.set({
			domainId: newDomain.domainId,
		})
		.where(
			eq(
				previewDeployments.previewDeploymentId,
				previewDeployment.previewDeploymentId,
			),
		);

	return previewDeployment;
};

export const findPreviewDeploymentsByPullRequestId = async (
	pullRequestId: string,
) => {
	const previewDeploymentResult = await db.query.previewDeployments.findMany({
		where: eq(previewDeployments.pullRequestId, pullRequestId),
	});

	return previewDeploymentResult;
};

export const findPreviewDeploymentByApplicationId = async (
	applicationId: string,
	pullRequestId: string,
) => {
	const previewDeploymentResult = await db.query.previewDeployments.findFirst({
		where: and(
			eq(previewDeployments.applicationId, applicationId),
			eq(previewDeployments.pullRequestId, pullRequestId),
		),
	});

	return previewDeploymentResult;
};

const generateWildcardDomain = async (
	baseDomain: string,
	appName: string,
	serverIp: string,
	_userId: string,
): Promise<string> => {
	if (!baseDomain.startsWith("*.")) {
		throw new Error('The base domain must start with "*."');
	}
	const hash = `${appName}`;
	if (baseDomain.includes("sslip.io")) {
		let ip = "";

		if (process.env.NODE_ENV === "development") {
			ip = "127.0.0.1";
		}

		if (serverIp) {
			ip = serverIp;
		}

		if (!ip) {
			const settings = await getWebServerSettings();
			ip = settings?.serverIp || "";
		}

		const slugIp = ip.replaceAll(".", "-");
		return baseDomain.replace(
			"*",
			`${hash}${slugIp === "" ? "" : `-${slugIp}`}`,
		);
	}

	return baseDomain.replace("*", hash);
};
