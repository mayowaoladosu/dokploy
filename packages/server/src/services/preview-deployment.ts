import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	type apiCreatePreviewDeployment,
	deployments,
	domains,
	organization,
	previewDeployments,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, lte, or } from "drizzle-orm";
import postgres from "postgres";
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

export const previewDeploymentExpiry = (now = new Date()) => {
	const configured = Number.parseInt(
		process.env.PREVIEW_DEPLOYMENT_TTL_HOURS ?? "168",
		10,
	);
	const hours =
		Number.isSafeInteger(configured) && configured >= 1 && configured <= 720
			? configured
			: 168;
	return new Date(now.getTime() + hours * 60 * 60_000);
};

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
		if (error instanceof TRPCError && error.code === "NOT_FOUND") return null;
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
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const lockName = `vlyv:preview:${schema.applicationId}:${schema.pullRequestId}`;
	try {
		await lockClient`
			select pg_advisory_lock(hashtextextended(${lockName}, 0))
		`;
		const application = await findApplicationById(schema.applicationId);
		let previewDeployment = await db.query.previewDeployments.findFirst({
			where: and(
				eq(previewDeployments.applicationId, schema.applicationId),
				eq(previewDeployments.pullRequestId, schema.pullRequestId),
			),
			with: { domain: true },
		});
		const appName =
			previewDeployment?.appName ??
			buildPreviewAppName(application.appName, generatePassword(6));
		const managedDomain = getManagedApplicationDomain(appName);
		const org = await db.query.organization.findFirst({
			where: eq(
				organization.id,
				application.environment.project.organizationId,
			),
		});
		const generatedDomain =
			managedDomain ||
			(await generateWildcardDomain(
				application.previewWildcard || "*.sslip.io",
				appName,
				application.server?.ipAddress || "",
				org?.ownerId || "",
			));
		const previewHttps = Boolean(managedDomain) || application.previewHttps;

		if (!previewDeployment) {
			const [created] = await db
				.insert(previewDeployments)
				.values({
					...schema,
					appName,
					pullRequestCommentId: "",
					expiresAt: previewDeploymentExpiry().toISOString(),
				})
				.onConflictDoNothing({
					target: [
						previewDeployments.applicationId,
						previewDeployments.pullRequestId,
					],
				})
				.returning();
			previewDeployment = created
				? { ...created, domain: null }
				: await db.query.previewDeployments.findFirst({
						where: and(
							eq(previewDeployments.applicationId, schema.applicationId),
							eq(previewDeployments.pullRequestId, schema.pullRequestId),
						),
						with: { domain: true },
					});
		}
		if (!previewDeployment) {
			throw new Error("Failed to persist preview deployment intent");
		}

		let pullRequestCommentId = previewDeployment.pullRequestCommentId;
		if (application.githubId && !pullRequestCommentId) {
			const githubProvider = await findGithubById(application.githubId);
			const octokit = authGithub(githubProvider);
			const marker = `vlyv-preview:${previewDeployment.previewDeploymentId}`;
			const comments = await octokit.rest.issues.listComments({
				owner: application.owner || "",
				repo: application.repository || "",
				issue_number: Number.parseInt(schema.pullRequestNumber),
				per_page: 100,
			});
			const existing = comments.data.find((comment) =>
				comment.body?.includes(marker),
			);
			if (existing) {
				pullRequestCommentId = String(existing.id);
			} else {
				const runningComment = getIssueComment(
					application.name,
					"initializing",
					`${previewHttps ? "https" : "http"}://${generatedDomain}`,
				);
				const issue = await octokit.rest.issues.createComment({
					owner: application.owner || "",
					repo: application.repository || "",
					issue_number: Number.parseInt(schema.pullRequestNumber),
					body: `### Dokploy Preview Deployment\n\n${runningComment}\n\n<!-- ${marker} -->`,
				});
				pullRequestCommentId = String(issue.data.id);
			}
		}

		let previewDomain =
			"domain" in previewDeployment ? previewDeployment.domain : null;
		if (!previewDomain) {
			previewDomain =
				(await db.query.domains.findFirst({
					where: or(
						eq(
							domains.previewDeploymentId,
							previewDeployment.previewDeploymentId,
						),
						eq(domains.host, generatedDomain),
					),
				})) ?? null;
		}
		previewDomain ??= await createDomain({
			host: generatedDomain,
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
			await manageDomain(application, previewDomain);
		}

		const [updated] = await db
			.update(previewDeployments)
			.set({
				...schema,
				domainId: previewDomain.domainId,
				pullRequestCommentId,
				expiresAt: previewDeploymentExpiry().toISOString(),
			})
			.where(
				eq(
					previewDeployments.previewDeploymentId,
					previewDeployment.previewDeploymentId,
				),
			)
			.returning();
		return updated ?? previewDeployment;
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended(${lockName}, 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
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

export const reconcileExpiredPreviewDeployments = async (
	now = new Date(),
	limit = 50,
	beforeRemove?: (previewDeploymentId: string) => Promise<void>,
) => {
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended('vlyv:preview-expiry', 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		return { expired: 0, failed: 0 };
	}
	try {
		const expired = await db.query.previewDeployments.findMany({
			where: lte(previewDeployments.expiresAt, now.toISOString()),
			orderBy: [asc(previewDeployments.expiresAt)],
			limit,
		});
		let removed = 0;
		let failed = 0;
		for (const preview of expired) {
			try {
				await beforeRemove?.(preview.previewDeploymentId);
				await removePreviewDeployment(preview.previewDeploymentId);
				removed += 1;
			} catch (error) {
				failed += 1;
				console.error(
					`Failed to expire preview ${preview.previewDeploymentId}`,
					error,
				);
			}
		}
		return { expired: removed, failed };
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended('vlyv:preview-expiry', 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
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
