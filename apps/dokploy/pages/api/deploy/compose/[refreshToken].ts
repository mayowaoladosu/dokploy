import {
	admitGitDelivery,
	detectGitWebhookProvider,
	extractGitWebhookDeliveryId,
	gitWebhookPayloadHash,
	gitWebhookProviderScopeHash,
	IS_CLOUD,
	IS_MANAGED_PAAS,
	normalizeGitWebhookEvent,
	shouldDeploy,
	verifyGitWebhookSignature,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { compose } from "@/server/db/schema";
import {
	enqueueGitDeliveryTarget,
	readRawJsonWebhook,
} from "@/server/git-delivery";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";
import { deploy } from "@/server/utils/deploy";
import {
	extractBranchName,
	extractCommitMessage,
	extractCommittedPaths,
	extractDeliveryId,
	extractHash,
	getProviderByHeader,
	logWebhookError,
} from "../[refreshToken]";

export const config = { api: { bodyParser: false } };

const secureComposeHandler = async (
	req: NextApiRequest,
	res: NextApiResponse,
) => {
	if (req.method && req.method !== "POST") {
		return res.status(405).json({ message: "Method not allowed" });
	}
	if (IS_MANAGED_PAAS) {
		return res.status(404).json({ message: "Not found" });
	}
	const { refreshToken } = req.query;
	const { rawBody, body } = await readRawJsonWebhook(req);
	const composeResult = await db.query.compose.findFirst({
		where: eq(compose.refreshToken, refreshToken as string),
		with: {
			environment: { with: { project: true } },
			github: true,
			gitlab: true,
			gitea: true,
			bitbucket: true,
		},
	});
	if (!composeResult)
		return res.status(404).json({ message: "Compose Not Found" });
	if (!composeResult.autoDeploy) {
		return res
			.status(400)
			.json({ message: "Automatic deployments are disabled" });
	}
	const provider = detectGitWebhookProvider(req.headers);
	const verification = verifyGitWebhookSignature({
		provider,
		headers: req.headers,
		rawBody,
		secret: String(refreshToken),
		required: provider !== "generic",
	});
	if (!verification.verified && provider !== "generic") {
		return res.status(401).json({ message: "Invalid webhook signature" });
	}
	const event = normalizeGitWebhookEvent({
		provider,
		headers: req.headers,
		body,
	});
	const configuredBranch =
		composeResult.sourceType === "github"
			? composeResult.branch
			: composeResult.sourceType === "gitlab"
				? composeResult.gitlabBranch
				: composeResult.sourceType === "gitea"
					? composeResult.giteaBranch
					: composeResult.sourceType === "bitbucket"
						? composeResult.bitbucketBranch
						: composeResult.customGitBranch;
	let changedPaths = event.changedPaths;
	if (provider === "bitbucket" && event.eventType === "push") {
		changedPaths = await extractCommittedPaths(
			body,
			composeResult.bitbucket,
			composeResult.bitbucketRepositorySlug ??
				composeResult.bitbucketRepository ??
				"",
		);
	}
	const deploys =
		(event.eventType === "push" && event.branch === configuredBranch) ||
		(event.eventType === "tag" && composeResult.triggerType === "tag");
	const targetPlans: Parameters<typeof admitGitDelivery>[0]["targets"] = [];
	if (deploys && shouldDeploy(composeResult.watchPaths, changedPaths)) {
		const job: DeploymentJob = {
			composeId: composeResult.composeId,
			titleLog: event.commitMessage ?? "Git delivery",
			descriptionLog: event.commitSha ? `Hash: ${event.commitSha}` : "",
			type: "deploy",
			applicationType: "compose",
			server: !!composeResult.serverId,
			serverId: composeResult.serverId ?? undefined,
		};
		targetPlans.push({
			targetKey: `compose:${composeResult.composeId}`,
			composeId: composeResult.composeId,
			targetName: composeResult.name,
			job: { kind: "deployment", deployment: job },
		});
	}
	const providerRecord =
		provider === "github"
			? composeResult.github
			: provider === "gitlab"
				? composeResult.gitlab
				: provider === "gitea"
					? composeResult.gitea
					: provider === "bitbucket"
						? composeResult.bitbucket
						: null;
	const providerConnectionId =
		provider === "github"
			? composeResult.githubId
			: provider === "gitlab"
				? composeResult.gitlabId
				: provider === "gitea"
					? composeResult.giteaId
					: provider === "bitbucket"
						? composeResult.bitbucketId
						: null;
	const payloadHash = gitWebhookPayloadHash(rawBody);
	const scopeHash = gitWebhookProviderScopeHash(
		`compose:${composeResult.composeId}`,
	);
	const admitted = await admitGitDelivery({
		organizationId: composeResult.environment.project.organizationId,
		gitProviderId: providerRecord?.gitProviderId ?? undefined,
		providerConnectionId: providerConnectionId ?? undefined,
		provider,
		providerScopeHash: scopeHash,
		providerDeliveryId: extractGitWebhookDeliveryId({
			provider,
			headers: req.headers,
			payloadHash,
			scopeHash,
			eventType: event.eventType,
		}),
		eventType: event.eventType,
		repositoryOwner: event.repositoryOwner,
		repositoryName: event.repositoryName,
		branch: event.branch,
		commitSha: event.commitSha,
		commitMessage: event.commitMessage,
		payloadHash,
		targets: targetPlans,
	});
	for (const target of admitted.targets) {
		await enqueueGitDeliveryTarget(target.gitDeliveryTargetId).catch((error) =>
			logWebhookError("Failed to enqueue compose Git delivery", error),
		);
	}
	return res.status(202).json({
		message: targetPlans.length
			? "Git delivery accepted"
			: "Git delivery ignored",
		deliveryId: admitted.delivery.gitDeliveryId,
		duplicate: admitted.duplicate,
	});
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	try {
		return await secureComposeHandler(req, res);
	} catch (error) {
		logWebhookError("Error processing compose Git delivery", error);
		return res.status(400).json({ message: "Error processing Git delivery" });
	}
}

export async function legacyComposeWebhookHandler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { refreshToken } = req.query;
	const deliveryId = extractDeliveryId(req.headers);
	try {
		if (req.headers["x-github-event"] === "ping") {
			res.status(200).json({ message: "Ping received, webhook is active" });
			return;
		}
		const composeResult = await db.query.compose.findFirst({
			where: eq(compose.refreshToken, refreshToken as string),
			with: {
				environment: {
					with: {
						project: true,
					},
				},
				bitbucket: true,
			},
		});

		if (!composeResult) {
			res.status(404).json({ message: "Compose Not Found" });
			return;
		}
		if (!composeResult?.autoDeploy) {
			res.status(400).json({
				message: "Automatic deployments are disabled for this compose",
			});
			return;
		}

		const deploymentTitle = extractCommitMessage(req.headers, req.body);
		const deploymentHash = extractHash(req.headers, req.body);
		const sourceType = composeResult.sourceType;

		if (sourceType === "github") {
			const branchName = extractBranchName(req.headers, req.body);
			const normalizedCommits = req.body?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}

			if (!branchName || branchName !== composeResult.branch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		} else if (sourceType === "gitlab") {
			const branchName = extractBranchName(req.headers, req.body);
			const normalizedCommits = req.body?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
			if (!branchName || branchName !== composeResult.gitlabBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		} else if (sourceType === "bitbucket") {
			const branchName = extractBranchName(req.headers, req.body);
			if (!branchName || branchName !== composeResult.bitbucketBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}

			const committedPaths = await extractCommittedPaths(
				req.body,
				composeResult.bitbucket,
				composeResult.bitbucketRepositorySlug ||
					composeResult.bitbucketRepository ||
					"",
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				committedPaths,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
		} else if (sourceType === "git") {
			const branchName = extractBranchName(req.headers, req.body);
			if (!branchName || branchName !== composeResult.customGitBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
			const provider = getProviderByHeader(req.headers);
			let normalizedCommits: string[] = [];

			if (provider === "github") {
				normalizedCommits = req.body?.commits?.flatMap(
					(commit: any) => commit.modified,
				);
			} else if (provider === "gitlab") {
				normalizedCommits = req.body?.commits?.flatMap(
					(commit: any) => commit.modified,
				);
			} else if (provider === "gitea") {
				normalizedCommits = req.body?.commits?.flatMap(
					(commit: any) => commit.modified,
				);
			}

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}
		} else if (sourceType === "gitea") {
			const branchName = extractBranchName(req.headers, req.body);

			const normalizedCommits = req.body?.commits?.flatMap(
				(commit: any) => commit.modified,
			);

			const shouldDeployPaths = shouldDeploy(
				composeResult.watchPaths,
				normalizedCommits,
			);

			if (!shouldDeployPaths) {
				res.status(301).json({ message: "Watch Paths Not Match" });
				return;
			}

			if (!branchName || branchName !== composeResult.giteaBranch) {
				res.status(301).json({ message: "Branch Not Match" });
				return;
			}
		}

		try {
			const jobData: DeploymentJob = {
				composeId: composeResult.composeId as string,
				titleLog: deploymentTitle,
				type: "deploy",
				applicationType: "compose",
				descriptionLog: `Hash: ${deploymentHash}`,
				server: !!composeResult.serverId,
			};

			if (IS_CLOUD && composeResult.serverId) {
				jobData.serverId = composeResult.serverId;
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
			} else {
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
		} catch (error) {
			logWebhookError("Error deploying Compose:", error);
			res.status(400).json({ message: "Error deploying Compose" });
			return;
		}

		res.status(200).json({ message: "Compose deployed successfully" });
	} catch (error) {
		logWebhookError("Error deploying Compose:", error);
		res.status(400).json({ message: "Error deploying Compose" });
	}
}
