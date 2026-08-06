import {
	admitGitDelivery,
	checkUserRepositoryPermissions,
	createPreviewDeployment,
	createSecurityBlockedComment,
	extractGitWebhookDeliveryId,
	findGithubById,
	findPreviewDeploymentByApplicationId,
	findPreviewDeploymentsByPullRequestId,
	gitWebhookPayloadHash,
	gitWebhookProviderScopeHash,
	IS_CLOUD,
	IS_MANAGED_PAAS,
	normalizeGitWebhookEvent,
	removePreviewDeployment,
	resolveGitBranchEnvironmentMapping,
	shouldDeploy,
	verifyGitWebhookSignature,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { Webhooks } from "@octokit/webhooks";
import { and, eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	applications,
	compose,
	github,
	previewDeployments,
} from "@/server/db/schema";
import {
	enqueueGitDeliveryTarget,
	readRawJsonWebhook,
} from "@/server/git-delivery";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	cleanQueuesByPreviewDeployment,
	myQueue,
} from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import {
	extractCommitMessage,
	extractDeliveryId,
	extractHash,
	logWebhookError,
} from "./[refreshToken]";

const getGithubRepositoryOwner = (githubBody: any) =>
	githubBody?.repository?.owner?.name ?? githubBody?.repository?.owner?.login;

export const config = { api: { bodyParser: false } };

const secureGithubHandler = async (
	req: NextApiRequest,
	res: NextApiResponse,
) => {
	if (req.method && req.method !== "POST") {
		return res.status(405).json({ message: "Method not allowed" });
	}
	const { rawBody, body } = await readRawJsonWebhook(req);
	const installationId = body.installation?.id;
	if (!installationId) {
		return res.status(400).json({ message: "Github Installation not found" });
	}
	const githubResult = await db.query.github.findFirst({
		where: eq(github.githubInstallationId, installationId),
		with: { gitProvider: true },
	});
	if (!githubResult?.githubWebhookSecret) {
		return res.status(400).json({ message: "Github Installation not found" });
	}
	const verification = verifyGitWebhookSignature({
		provider: "github",
		headers: req.headers,
		rawBody,
		secret: githubResult.githubWebhookSecret,
	});
	if (!verification.verified) {
		return res.status(401).json({ message: "Unauthorized" });
	}
	if (req.headers["x-github-event"] === "ping") {
		return res
			.status(200)
			.json({ message: "Ping received, webhook is active" });
	}
	const event = normalizeGitWebhookEvent({
		provider: "github",
		headers: req.headers,
		body,
	});
	if (!["push", "tag", "pull_request"].includes(event.eventType)) {
		return res.status(400).json({ message: "Unsupported Github event" });
	}
	if (
		[
			"[skip ci]",
			"[ci skip]",
			"[no ci]",
			"[skip actions]",
			"[actions skip]",
		].some((keyword) => event.commitMessage?.includes(keyword))
	) {
		return res.status(200).json({ message: "Deployment skipped by commit" });
	}

	const owner = getGithubRepositoryOwner(body) ?? event.repositoryOwner ?? "";
	const repository = event.repositoryName ?? body.repository?.name ?? "";
	const scopeHash = gitWebhookProviderScopeHash(
		`github:${githubResult.githubId}:${installationId}`,
	);
	const payloadHash = gitWebhookPayloadHash(rawBody);
	const providerDeliveryId = extractGitWebhookDeliveryId({
		provider: "github",
		headers: req.headers,
		payloadHash,
		scopeHash,
		eventType: event.eventType,
	});
	const targetPlans: Parameters<typeof admitGitDelivery>[0]["targets"] = [];

	if (event.eventType === "push" || event.eventType === "tag") {
		const apps = await db.query.applications.findMany({
			where: and(
				eq(applications.sourceType, "github"),
				eq(applications.autoDeploy, true),
				eq(
					applications.triggerType,
					event.eventType === "tag" ? "tag" : "push",
				),
				eq(applications.repository, repository),
				eq(applications.owner, owner),
				eq(applications.githubId, githubResult.githubId),
			),
			with: { environment: { with: { project: true } } },
		});
		for (const app of apps) {
			const mapping =
				event.eventType === "push" && event.branch
					? await resolveGitBranchEnvironmentMapping({
							application: app,
							provider: "github",
							repositoryOwner: owner,
							repositoryName: repository,
							branch: event.branch,
						})
					: event.eventType === "tag"
						? { isProduction: app.environment.isDefault }
						: null;
			if (!mapping || !shouldDeploy(app.watchPaths, event.changedPaths))
				continue;
			const job: DeploymentJob = {
				applicationId: app.applicationId,
				titleLog:
					event.eventType === "tag"
						? `Tag created: ${event.branch ?? "unknown"}`
						: (event.commitMessage ?? "GitHub delivery"),
				descriptionLog: event.commitSha ? `Hash: ${event.commitSha}` : "",
				type: "deploy",
				applicationType: "application",
				server: !!app.serverId,
				serverId: app.serverId ?? undefined,
				sourceBranch: event.eventType === "push" ? event.branch : undefined,
			};
			targetPlans.push({
				targetKey: `application:${app.applicationId}`,
				applicationId: app.applicationId,
				targetName: app.name,
				job: { kind: "deployment", deployment: job },
			});
		}

		const composeApps = await db.query.compose.findMany({
			where: and(
				eq(compose.sourceType, "github"),
				eq(compose.autoDeploy, true),
				eq(compose.triggerType, event.eventType === "tag" ? "tag" : "push"),
				eq(compose.repository, repository),
				eq(compose.owner, owner),
				eq(compose.githubId, githubResult.githubId),
				...(event.eventType === "push" && event.branch
					? [eq(compose.branch, event.branch)]
					: []),
			),
		});
		for (const composeApp of composeApps) {
			if (!shouldDeploy(composeApp.watchPaths, event.changedPaths)) continue;
			const job: DeploymentJob = {
				composeId: composeApp.composeId,
				titleLog: event.commitMessage ?? "GitHub delivery",
				descriptionLog: event.commitSha ? `Hash: ${event.commitSha}` : "",
				type: "deploy",
				applicationType: "compose",
				server: !!composeApp.serverId,
				serverId: composeApp.serverId ?? undefined,
			};
			targetPlans.push({
				targetKey: `compose:${composeApp.composeId}`,
				composeId: composeApp.composeId,
				targetName: composeApp.name,
				job: { kind: "deployment", deployment: job },
			});
		}
	} else if (event.pullRequestId && event.pullRequestNumber && event.branch) {
		if (event.closed) {
			const previews = await db.query.previewDeployments.findMany({
				where: eq(previewDeployments.pullRequestId, event.pullRequestId),
				with: { application: true },
			});
			for (const preview of previews) {
				if (preview.application?.githubId !== githubResult.githubId) continue;
				targetPlans.push({
					targetKey: `preview-cleanup:${preview.previewDeploymentId}`,
					applicationId: preview.applicationId,
					previewDeploymentId: preview.previewDeploymentId,
					targetName: preview.application?.name ?? "Preview",
					externalCommentId: preview.pullRequestCommentId,
					job: {
						kind: "preview_cleanup",
						previewDeploymentId: preview.previewDeploymentId,
					},
				});
			}
		} else if (
			["opened", "synchronize", "reopened", "labeled"].includes(
				event.action ?? "",
			)
		) {
			const apps = await db.query.applications.findMany({
				where: and(
					eq(applications.sourceType, "github"),
					eq(applications.repository, repository),
					eq(applications.isPreviewDeploymentsActive, true),
					eq(applications.owner, owner),
					eq(applications.githubId, githubResult.githubId),
				),
				with: {
					environment: { with: { project: true } },
					previewDeployments: true,
				},
			});
			for (const app of apps) {
				const mapping = await resolveGitBranchEnvironmentMapping({
					application: app,
					provider: "github",
					repositoryOwner: owner,
					repositoryName: repository,
					branch: event.branch,
				});
				if (!mapping) continue;
				if (app.previewLabels?.length) {
					const labels = (body.pull_request?.labels ?? []).map(
						(label: { name?: string }) => label.name,
					);
					if (!app.previewLabels.some((label) => labels.includes(label)))
						continue;
				}
				if (
					app.previewLimit &&
					app.previewLimit > 0 &&
					app.previewDeployments.length >= app.previewLimit &&
					!app.previewDeployments.some(
						(preview) => preview.pullRequestId === event.pullRequestId,
					)
				) {
					continue;
				}
				if (!event.pullRequestAuthor) continue;
				if (
					IS_MANAGED_PAAS ||
					app.previewRequireCollaboratorPermissions !== false
				) {
					const provider = await findGithubById(githubResult.githubId);
					const permission = await checkUserRepositoryPermissions(
						provider,
						owner,
						repository,
						event.pullRequestAuthor,
					);
					if (!permission.hasWriteAccess) {
						await createSecurityBlockedComment({
							owner,
							repository,
							prNumber: event.pullRequestNumber,
							prAuthor: event.pullRequestAuthor,
							permission: permission.permission,
							githubId: githubResult.githubId,
						});
						continue;
					}
				}
				const existing = await findPreviewDeploymentByApplicationId(
					app.applicationId,
					event.pullRequestId,
				);
				const preview =
					existing ??
					(await createPreviewDeployment({
						applicationId: app.applicationId,
						branch: event.sourceBranch ?? event.branch,
						pullRequestId: event.pullRequestId,
						pullRequestNumber: String(event.pullRequestNumber),
						pullRequestTitle: event.pullRequestTitle ?? "Pull request",
						pullRequestURL: event.pullRequestUrl ?? "",
					}));
				const job: DeploymentJob = {
					applicationId: app.applicationId,
					titleLog: "Preview Deployment",
					descriptionLog: event.commitSha ? `Hash: ${event.commitSha}` : "",
					type: existing ? "redeploy" : "deploy",
					applicationType: "application-preview",
					previewDeploymentId: preview.previewDeploymentId,
					server: !!app.serverId,
					serverId: app.serverId ?? undefined,
				};
				targetPlans.push({
					targetKey: `preview:${preview.previewDeploymentId}`,
					applicationId: app.applicationId,
					previewDeploymentId: preview.previewDeploymentId,
					targetName: app.name,
					externalCommentId: preview.pullRequestCommentId,
					job: { kind: "deployment", deployment: job },
				});
			}
		}
	}

	const admitted = await admitGitDelivery({
		organizationId: githubResult.gitProvider.organizationId,
		gitProviderId: githubResult.gitProviderId,
		providerConnectionId: githubResult.githubId,
		provider: "github",
		providerScopeHash: scopeHash,
		providerDeliveryId,
		eventType: event.eventType,
		repositoryOwner: owner,
		repositoryName: repository,
		branch: event.branch,
		commitSha: event.commitSha,
		commitMessage: event.commitMessage,
		payloadHash,
		metadata: {
			action: event.action,
			pullRequestId: event.pullRequestId,
			pullRequestNumber: event.pullRequestNumber,
			pullRequestTitle: event.pullRequestTitle,
			pullRequestUrl: event.pullRequestUrl,
		},
		targets: targetPlans,
	});
	for (const target of admitted.targets) {
		await enqueueGitDeliveryTarget(target.gitDeliveryTargetId).catch((error) =>
			logWebhookError("Failed to enqueue Github delivery target", error),
		);
	}
	return res.status(202).json({
		message:
			targetPlans.length > 0 ? "Github delivery accepted" : "No apps to deploy",
		deliveryId: admitted.delivery.gitDeliveryId,
		duplicate: admitted.duplicate,
	});
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	try {
		return await secureGithubHandler(req, res);
	} catch (error) {
		logWebhookError("Error processing Github delivery:", error);
		return res
			.status(400)
			.json({ message: "Error processing Github delivery" });
	}
}

export async function legacyGithubHandler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const signature = req.headers["x-hub-signature-256"];
	if (!signature) {
		res.status(401).json({ message: "Missing signature header" });
		return;
	}

	const githubBody = req.body;

	if (!githubBody?.installation?.id) {
		res.status(400).json({ message: "Github Installation not found" });
		return;
	}

	const githubResult = await db.query.github.findFirst({
		where: eq(github.githubInstallationId, githubBody.installation.id),
	});

	if (!githubResult) {
		res.status(400).json({ message: "Github Installation not found" });
		return;
	}

	if (!githubResult.githubWebhookSecret) {
		res.status(400).json({ message: "Github Webhook Secret not set" });
		return;
	}
	const webhooks = new Webhooks({
		secret: githubResult.githubWebhookSecret,
	});

	const verified = await webhooks.verify(
		JSON.stringify(githubBody),
		signature as string,
	);

	if (!verified) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	const deliveryId = extractDeliveryId(req.headers);

	if (req.headers["x-github-event"] === "ping") {
		res.status(200).json({ message: "Ping received, webhook is active" });
		return;
	}

	if (
		req.headers["x-github-event"] !== "push" &&
		req.headers["x-github-event"] !== "pull_request"
	) {
		res
			.status(400)
			.json({ message: "We only accept push events or pull_request events" });
		return;
	}

	// skip workflow runs use keywords
	// @link https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs
	if (
		[
			"[skip ci]",
			"[ci skip]",
			"[no ci]",
			"[skip actions]",
			"[actions skip]",
		].find((keyword) =>
			extractCommitMessage(req.headers, req.body).includes(keyword),
		)
	) {
		res.status(200).json({
			message: "Deployment skipped: commit message contains skip keyword",
		});
		return;
	}

	// Handle tag creation event
	if (
		req.headers["x-github-event"] === "push" &&
		githubBody?.ref?.startsWith("refs/tags/")
	) {
		try {
			const tagName = githubBody?.ref.replace("refs/tags/", "");
			const repository = githubBody?.repository?.name;
			const owner = getGithubRepositoryOwner(githubBody);
			const deploymentTitle = `Tag created: ${tagName}`;
			const deploymentHash = extractHash(req.headers, githubBody);

			// Find applications configured to deploy on tag
			const apps = await db.query.applications.findMany({
				where: and(
					eq(applications.sourceType, "github"),
					eq(applications.autoDeploy, true),
					eq(applications.triggerType, "tag"),
					eq(applications.repository, repository),
					eq(applications.owner, owner),
					eq(applications.githubId, githubResult.githubId),
				),
			});

			for (const app of apps) {
				const jobData: DeploymentJob = {
					applicationId: app.applicationId as string,
					titleLog: deploymentTitle,
					descriptionLog: `Hash: ${deploymentHash}`,
					type: "deploy",
					applicationType: "application",
					server: !!app.serverId,
				};

				if (IS_CLOUD && app.serverId) {
					jobData.serverId = app.serverId;
					deploy(jobData).catch((error) => {
						console.error("Background deployment failed:", error);
					});
					continue;
				}
				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
						jobId: deliveryId,
					},
				);
			}

			// Find compose apps configured to deploy on tag
			const composeApps = await db.query.compose.findMany({
				where: and(
					eq(compose.sourceType, "github"),
					eq(compose.autoDeploy, true),
					eq(compose.triggerType, "tag"),
					eq(compose.repository, repository),
					eq(compose.owner, owner),
					eq(compose.githubId, githubResult.githubId),
				),
			});

			for (const composeApp of composeApps) {
				const jobData: DeploymentJob = {
					composeId: composeApp.composeId as string,
					titleLog: deploymentTitle,
					type: "deploy",
					applicationType: "compose",
					descriptionLog: `Hash: ${deploymentHash}`,
					server: !!composeApp.serverId,
				};

				if (IS_CLOUD && composeApp.serverId) {
					jobData.serverId = composeApp.serverId;
					deploy(jobData).catch((error) => {
						console.error("Background deployment failed:", error);
					});
					continue;
				}

				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
						jobId: deliveryId,
					},
				);
			}

			const totalApps = apps.length + composeApps.length;

			if (totalApps === 0) {
				res
					.status(200)
					.json({ message: "No apps configured to deploy on tag" });
				return;
			}

			res.status(200).json({
				message: `Deployed ${totalApps} apps based on tag ${tagName}`,
			});
			return;
		} catch (error) {
			logWebhookError("Error deploying applications on tag:", error);
			res.status(400).json({ message: "Error deploying applications on tag" });
			return;
		}
	}

	if (req.headers["x-github-event"] === "push") {
		try {
			const branchName = githubBody?.ref?.replace("refs/heads/", "");
			const repository = githubBody?.repository?.name;

			const deploymentTitle = extractCommitMessage(req.headers, req.body);
			const deploymentHash = extractHash(req.headers, req.body);
			const owner = getGithubRepositoryOwner(githubBody);
			const normalizedCommits = githubBody?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const apps = await db.query.applications.findMany({
				where: and(
					eq(applications.sourceType, "github"),
					eq(applications.autoDeploy, true),
					eq(applications.triggerType, "push"),
					eq(applications.branch, branchName),
					eq(applications.repository, repository),
					eq(applications.owner, owner),
					eq(applications.githubId, githubResult.githubId),
				),
			});

			for (const app of apps) {
				const jobData: DeploymentJob = {
					applicationId: app.applicationId as string,
					titleLog: deploymentTitle,
					descriptionLog: `Hash: ${deploymentHash}`,
					type: "deploy",
					applicationType: "application",
					server: !!app.serverId,
				};

				const shouldDeployPaths = shouldDeploy(
					app.watchPaths,
					normalizedCommits,
				);

				if (!shouldDeployPaths) {
					continue;
				}

				if (IS_CLOUD && app.serverId) {
					jobData.serverId = app.serverId;
					deploy(jobData).catch((error) => {
						console.error("Background deployment failed:", error);
					});
					continue;
				}
				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
						jobId: deliveryId,
					},
				);
			}

			const composeApps = await db.query.compose.findMany({
				where: and(
					eq(compose.sourceType, "github"),
					eq(compose.autoDeploy, true),
					eq(compose.triggerType, "push"),
					eq(compose.branch, branchName),
					eq(compose.repository, repository),
					eq(compose.owner, owner),
					eq(compose.githubId, githubResult.githubId),
				),
			});

			for (const composeApp of composeApps) {
				const jobData: DeploymentJob = {
					composeId: composeApp.composeId as string,
					titleLog: deploymentTitle,
					type: "deploy",
					applicationType: "compose",
					descriptionLog: `Hash: ${deploymentHash}`,
					server: !!composeApp.serverId,
				};

				const shouldDeployPaths = shouldDeploy(
					composeApp.watchPaths,
					normalizedCommits,
				);

				if (!shouldDeployPaths) {
					continue;
				}
				if (IS_CLOUD && composeApp.serverId) {
					jobData.serverId = composeApp.serverId;
					deploy(jobData).catch((error) => {
						console.error("Background deployment failed:", error);
					});
					continue;
				}

				await myQueue.add(
					"deployments",
					{ ...jobData },
					{
						removeOnComplete: true,
						removeOnFail: true,
						jobId: deliveryId,
					},
				);
			}

			const totalApps = apps.length + composeApps.length;
			const emptyApps = totalApps === 0;

			if (emptyApps) {
				res.status(200).json({ message: "No apps to deploy" });
				return;
			}
			res.status(200).json({ message: `Deployed ${totalApps} apps` });
		} catch (error) {
			logWebhookError("Error deploying Application:", error);
			res.status(400).json({ message: "Error deploying Application" });
		}
	} else if (req.headers["x-github-event"] === "pull_request") {
		const prId = githubBody?.pull_request?.id;
		const action = githubBody?.action;

		if (action === "closed") {
			const previewDeploymentResult =
				await findPreviewDeploymentsByPullRequestId(prId);

			if (previewDeploymentResult.length > 0) {
				for (const previewDeployment of previewDeploymentResult) {
					try {
						await cleanQueuesByPreviewDeployment(
							previewDeployment.previewDeploymentId,
							{ waitForCompletion: true },
						);
						await removePreviewDeployment(
							previewDeployment.previewDeploymentId,
						);
					} catch (error) {
						console.log(error);
					}
				}
			}
			res.status(200).json({ message: "Preview Deployment Closed" });
			return;
		}

		// opened or synchronize or reopened
		if (
			action === "opened" ||
			action === "synchronize" ||
			action === "reopened" ||
			action === "labeled" ||
			action === "unlabeled"
		) {
			const shouldCreateDeployment =
				action === "opened" ||
				action === "synchronize" ||
				action === "reopened" ||
				action === "labeled";

			const repository = githubBody?.repository?.name;
			const deploymentHash = githubBody?.pull_request?.head?.sha;
			const branch = githubBody?.pull_request?.base?.ref;
			const owner = getGithubRepositoryOwner(githubBody);
			const prAuthor = githubBody?.pull_request?.user?.login;

			// Validate PR author information is present
			if (!prAuthor) {
				console.warn(
					"⚠️ SECURITY: PR author information missing in webhook payload",
				);
				res.status(400).json({
					message: "PR author information missing",
				});
				return;
			}

			const apps = await db.query.applications.findMany({
				where: and(
					eq(applications.sourceType, "github"),
					eq(applications.repository, repository),
					eq(applications.branch, branch),
					eq(applications.isPreviewDeploymentsActive, true),
					eq(applications.owner, owner),
					eq(applications.githubId, githubResult.githubId),
				),
				with: {
					previewDeployments: true,
				},
			});

			// SECURITY: Check collaborator permissions per application setting
			const secureApps: typeof apps = [];
			const blockedApps: string[] = [];
			let userPermission: string | null = null;

			for (const app of apps) {
				// If the app requires collaborator permissions, verify them
				if (app.previewRequireCollaboratorPermissions !== false) {
					try {
						const githubProvider = await findGithubById(githubResult.githubId);
						const { hasWriteAccess, permission } =
							await checkUserRepositoryPermissions(
								githubProvider,
								owner,
								repository,
								prAuthor,
							);

						userPermission = permission; // Store permission for comment

						if (!hasWriteAccess) {
							console.warn(
								`🚨 SECURITY: Blocked preview deployment for ${app.name} from unauthorized user ${prAuthor} on ${owner}/${repository}. Permission: ${permission || "none"}`,
							);
							blockedApps.push(app.name);
							continue;
						}

						console.log(
							`✅ SECURITY: Preview deployment authorized for ${app.name} from user ${prAuthor} on ${owner}/${repository}. Permission: ${permission}`,
						);
					} catch (error) {
						console.error(
							`Error validating PR author permissions for ${app.name}:`,
							error,
						);
						blockedApps.push(app.name);
						continue; // Skip this app on error
					}
				} else {
					console.warn(
						`⚠️  SECURITY: Preview deployment for ${app.name} allows deployment from any PR author (security check disabled)`,
					);
				}
				secureApps.push(app);
			}

			const prBranch = githubBody?.pull_request?.head?.ref;

			const prNumber = githubBody?.pull_request?.number;
			const prTitle = githubBody?.pull_request?.title;
			const prURL = githubBody?.pull_request?.html_url;

			// Create security notification comment if any apps were blocked
			if (blockedApps.length > 0) {
				await createSecurityBlockedComment({
					owner,
					repository,
					prNumber: Number.parseInt(prNumber),
					prAuthor,
					permission: userPermission,
					githubId: githubResult.githubId,
				});
			}

			for (const app of secureApps) {
				// check for labels
				if (app?.previewLabels && app?.previewLabels?.length > 0) {
					let hasLabel = false;
					const labels = githubBody?.pull_request?.labels;
					for (const label of labels) {
						if (app?.previewLabels?.includes(label.name)) {
							hasLabel = true;
							break;
						}
					}
					if (!hasLabel) continue;
				}

				const previewLimit = app?.previewLimit || 0;
				if (app?.previewDeployments?.length > previewLimit) {
					continue;
				}
				const previewDeploymentResult =
					await findPreviewDeploymentByApplicationId(app.applicationId, prId);

				let previewDeploymentId =
					previewDeploymentResult?.previewDeploymentId || "";

				if (!previewDeploymentResult && shouldCreateDeployment) {
					const previewDeployment = await createPreviewDeployment({
						applicationId: app.applicationId as string,
						branch: prBranch,
						pullRequestId: prId,
						pullRequestNumber: prNumber,
						pullRequestTitle: prTitle,
						pullRequestURL: prURL,
					});
					previewDeploymentId = previewDeployment.previewDeploymentId;
				}

				const jobData: DeploymentJob = {
					applicationId: app.applicationId as string,
					titleLog: "Preview Deployment",
					descriptionLog: `Hash: ${deploymentHash}`,
					type: "deploy",
					applicationType: "application-preview",
					server: !!app.serverId,
					previewDeploymentId,
				};

				if (previewDeploymentId) {
					if (IS_CLOUD && app.serverId) {
						jobData.serverId = app.serverId;
						deploy(jobData).catch((error) => {
							console.error("Background deployment failed:", error);
						});
						continue;
					}
					await myQueue.add(
						"deployments",
						{ ...jobData },
						{
							removeOnComplete: true,
							removeOnFail: true,
							jobId: deliveryId,
						},
					);
				}
			}
			return res.status(200).json({ message: "Apps Deployed" });
		}
	}

	return res.status(400).json({ message: "No Actions matched" });
}
