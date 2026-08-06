import {
	admitGitDelivery,
	type Bitbucket,
	createPreviewDeployment,
	detectGitWebhookProvider,
	extractGitWebhookDeliveryId,
	findPreviewDeploymentByApplicationId,
	getBitbucketHeaders,
	gitWebhookPayloadHash,
	gitWebhookProviderScopeHash,
	IS_MANAGED_PAAS,
	normalizeGitWebhookEvent,
	resolveGitBranchEnvironmentMapping,
	shouldDeploy,
	verifyGitPullRequestAuthor,
	verifyGitWebhookSignature,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import { applications } from "@/server/db/schema";
import {
	enqueueGitDeliveryTarget,
	readRawJsonWebhook,
} from "@/server/git-delivery";
import type { DeploymentJob } from "@/server/queues/queue-types";

export const config = { api: { bodyParser: false } };

/**
 * Log a webhook handler error server-side without leaking its shape to the HTTP
 * response. Drizzle errors carry the raw SQL query, column list and parameters,
 * so we never forward the error object to the client.
 */
export const logWebhookError = (context: string, error: unknown) => {
	console.error(context, error);
};

export const extractDeliveryId = (headers: NextApiRequest["headers"]) => {
	const value =
		headers["idempotency-key"] ??
		headers["x-github-delivery"] ??
		headers["x-gitlab-event-uuid"] ??
		headers["x-gitea-delivery"] ??
		headers["x-request-uuid"];
	return Array.isArray(value) ? value[0] : value;
};

/**
 * Helper function to get package_version from registry_package events
 */
const getPackageVersion = (headers: any, body: any) => {
	const event = headers["x-github-event"];
	if (event === "registry_package") {
		return body.registry_package?.package_version;
	}
	return null;
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const { refreshToken } = req.query;
	try {
		if (req.method && req.method !== "POST") {
			res.status(405).json({ message: "Method not allowed" });
			return;
		}
		const { rawBody, body } = await readRawJsonWebhook(req);
		if (req.headers["x-github-event"] === "ping") {
			res.status(200).json({ message: "Ping received, webhook is active" });
			return;
		}
		const application = await db.query.applications.findFirst({
			where: eq(applications.refreshToken, refreshToken as string),
			with: {
				environment: {
					with: {
						project: true,
					},
				},
				bitbucket: true,
				github: true,
				gitlab: true,
				gitea: true,
			},
		});

		if (!application) {
			res.status(404).json({ message: "Application Not Found" });
			return;
		}
		if (!application?.autoDeploy) {
			res.status(400).json({
				message: "Automatic deployments are disabled for this application",
			});
			return;
		}
		const provider = detectGitWebhookProvider(req.headers);
		if (IS_MANAGED_PAAS && ["generic", "docker"].includes(provider)) {
			res.status(401).json({ message: "Signed Git provider webhook required" });
			return;
		}
		if (
			application.sourceType !== "git" &&
			application.sourceType !== "docker" &&
			application.sourceType !== provider
		) {
			res
				.status(400)
				.json({ message: "Webhook provider does not match source" });
			return;
		}
		const signature = verifyGitWebhookSignature({
			provider,
			headers: req.headers,
			rawBody,
			secret: String(refreshToken),
			required: provider !== "generic" || IS_MANAGED_PAAS,
		});
		const signatureVerified =
			signature.verified || (provider === "generic" && !IS_MANAGED_PAAS);
		if (!signatureVerified) {
			res.status(401).json({ message: "Invalid webhook signature" });
			return;
		}

		const event = normalizeGitWebhookEvent({
			provider,
			headers: req.headers,
			body,
		});
		const providerRecord =
			provider === "github"
				? application.github
				: provider === "gitlab"
					? application.gitlab
					: provider === "gitea"
						? application.gitea
						: provider === "bitbucket"
							? application.bitbucket
							: null;
		const providerConnectionId =
			provider === "github"
				? application.githubId
				: provider === "gitlab"
					? application.gitlabId
					: provider === "gitea"
						? application.giteaId
						: provider === "bitbucket"
							? application.bitbucketId
							: null;
		const repositoryOwner =
			event.repositoryOwner ??
			application.owner ??
			application.gitlabOwner ??
			application.giteaOwner ??
			application.bitbucketOwner ??
			"";
		const repositoryName =
			event.repositoryName ??
			application.repository ??
			application.gitlabRepository ??
			application.giteaRepository ??
			application.bitbucketRepositorySlug ??
			application.bitbucketRepository ??
			"";
		const payloadHash = gitWebhookPayloadHash(rawBody);
		const providerScopeHash = gitWebhookProviderScopeHash(
			`application:${application.applicationId}`,
		);
		const deliveryId = extractGitWebhookDeliveryId({
			provider,
			headers: req.headers,
			payloadHash,
			scopeHash: providerScopeHash,
			eventType: event.eventType,
		});
		const targets: Parameters<typeof admitGitDelivery>[0]["targets"] = [];
		let ignoredReason: string | undefined;
		if (application.sourceType === "docker") {
			const configuredImage = extractImageName(application.dockerImage);
			const configuredTag = extractImageTag(application.dockerImage);
			const deliveredImage = extractImageNameFromRequest(req.headers, body);
			const deliveredTag = extractImageTagFromRequest(req.headers, body);
			if (!configuredImage) {
				res
					.status(400)
					.json({ message: "Application image is not configured" });
				return;
			}
			if (deliveredImage && deliveredImage !== configuredImage) {
				res.status(400).json({ message: "Delivered image does not match" });
				return;
			}
			if (deliveredTag && configuredTag && deliveredTag !== configuredTag) {
				res.status(400).json({ message: "Delivered image tag does not match" });
				return;
			}
		}

		if (event.eventType === "pull_request") {
			if (!event.pullRequestId || !event.pullRequestNumber || !event.branch) {
				ignoredReason = "Incomplete pull request event";
			} else {
				const existingPreview = await findPreviewDeploymentByApplicationId(
					application.applicationId,
					event.pullRequestId,
				);
				if (event.closed) {
					if (existingPreview) {
						targets.push({
							targetKey: `preview-cleanup:${existingPreview.previewDeploymentId}`,
							applicationId: application.applicationId,
							previewDeploymentId: existingPreview.previewDeploymentId,
							targetName: application.name,
							job: {
								kind: "preview_cleanup",
								previewDeploymentId: existingPreview.previewDeploymentId,
							},
						});
					}
				} else if (!application.isPreviewDeploymentsActive) {
					ignoredReason = "Preview deployments are disabled";
				} else if (
					![
						"opened",
						"open",
						"reopened",
						"synchronize",
						"synchronized",
						"update",
						"updated",
						"created",
					].includes(event.action ?? "")
				) {
					ignoredReason = "Pull request action does not deploy";
				} else {
					const mapping = await resolveGitBranchEnvironmentMapping({
						application,
						provider,
						repositoryOwner,
						repositoryName,
						branch: event.branch,
					});
					if (!mapping) {
						ignoredReason = "Target branch is not mapped to this environment";
					} else if (
						(IS_MANAGED_PAAS ||
							application.previewRequireCollaboratorPermissions !== false) &&
						(!providerConnectionId ||
							!event.pullRequestAuthor ||
							!(await verifyGitPullRequestAuthor({
								provider,
								providerConnectionId,
								repositoryOwner,
								repositoryName,
								author: event.pullRequestAuthor,
								authorId: event.pullRequestAuthorId,
								providerProjectId: application.gitlabProjectId
									? String(application.gitlabProjectId)
									: undefined,
							})))
					) {
						res
							.status(403)
							.json({ message: "Pull request author is not trusted" });
						return;
					} else {
						const preview =
							existingPreview ??
							(await createPreviewDeployment({
								applicationId: application.applicationId,
								branch: event.sourceBranch ?? event.branch,
								pullRequestId: event.pullRequestId,
								pullRequestNumber: String(event.pullRequestNumber),
								pullRequestTitle: event.pullRequestTitle ?? "Pull request",
								pullRequestURL: event.pullRequestUrl ?? "",
							}));
						targets.push({
							targetKey: `preview:${preview.previewDeploymentId}`,
							applicationId: application.applicationId,
							previewDeploymentId: preview.previewDeploymentId,
							targetName: application.name,
							externalCommentId: preview.pullRequestCommentId || undefined,
							job: {
								kind: "deployment",
								deployment: {
									applicationId: application.applicationId,
									titleLog: "Preview Deployment",
									descriptionLog: event.commitSha
										? `Hash: ${event.commitSha}`
										: "",
									type: existingPreview ? "redeploy" : "deploy",
									applicationType: "application-preview",
									previewDeploymentId: preview.previewDeploymentId,
									server: !!application.serverId,
								},
							},
						});
					}
				}
			}
		} else {
			const branch = event.branch;
			let changedPaths = event.changedPaths;
			if (
				provider === "bitbucket" &&
				event.eventType === "push" &&
				changedPaths.length === 0
			) {
				changedPaths = await extractCommittedPaths(
					body,
					application.bitbucket,
					application.bitbucketRepositorySlug ??
						application.bitbucketRepository ??
						"",
				);
			}
			const mapping =
				branch && event.eventType === "push"
					? await resolveGitBranchEnvironmentMapping({
							application,
							provider,
							repositoryOwner,
							repositoryName,
							branch,
						})
					: null;
			if (event.eventType === "tag" && application.triggerType !== "tag") {
				ignoredReason = "Tag deployments are disabled";
			} else if (event.eventType === "push" && !mapping) {
				ignoredReason = "Branch is not mapped to this environment";
			} else if (!shouldDeploy(application.watchPaths, changedPaths)) {
				ignoredReason = "Watch paths did not match";
			} else if (
				[
					"[skip ci]",
					"[ci skip]",
					"[no ci]",
					"[skip actions]",
					"[actions skip]",
				].some((keyword) => event.commitMessage?.includes(keyword))
			) {
				ignoredReason = "Commit requested CI skip";
			} else {
				const job: DeploymentJob = {
					applicationId: application.applicationId,
					titleLog: event.commitMessage ?? "Git delivery",
					descriptionLog: event.commitSha ? `Hash: ${event.commitSha}` : "",
					type: "deploy",
					applicationType: "application",
					server: !!application.serverId,
					sourceBranch: event.eventType === "push" ? branch : undefined,
				};
				targets.push({
					targetKey: `application:${application.applicationId}`,
					applicationId: application.applicationId,
					targetName: application.name,
					job: { kind: "deployment", deployment: job },
				});
			}
		}

		const admitted = await admitGitDelivery({
			organizationId: application.environment.project.organizationId,
			gitProviderId: providerRecord?.gitProviderId ?? undefined,
			providerConnectionId: providerConnectionId ?? undefined,
			provider,
			providerScopeHash,
			providerDeliveryId: deliveryId,
			eventType: event.eventType,
			repositoryOwner: repositoryOwner || undefined,
			repositoryName: repositoryName || undefined,
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
				providerProjectId: application.gitlabProjectId
					? String(application.gitlabProjectId)
					: undefined,
				productionPromotion:
					targets.length > 0 && event.branch
						? ["main", "master", "production"].includes(
								event.branch.toLowerCase(),
							) && application.environment.isDefault
						: false,
			},
			targets,
		});
		for (const target of admitted.targets) {
			await enqueueGitDeliveryTarget(target.gitDeliveryTargetId).catch(
				(error) =>
					logWebhookError(
						"Failed to enqueue durable Git delivery target",
						error,
					),
			);
		}
		res.status(202).json({
			message:
				targets.length > 0
					? "Git delivery accepted"
					: (ignoredReason ?? "Git delivery ignored"),
			deliveryId: admitted.delivery.gitDeliveryId,
			duplicate: admitted.duplicate,
		});
	} catch (error) {
		logWebhookError("Error deploying Application:", error);
		res.status(400).json({ message: "Error deploying Application" });
	}
}

/**
 * Return the image name without the tag
 * Example: "my-image" => "my-image"
 * Example: "my-image:latest" => "my-image"
 * Example: "my-image:1.0.0" => "my-image"
 * Example: "myregistryhost:5000/fedora/httpd:version1.0" => "myregistryhost:5000/fedora/httpd"
 * @link https://docs.docker.com/reference/cli/docker/image/tag/
 */
export function extractImageName(dockerImage: string | null): string | null {
	if (!dockerImage || typeof dockerImage !== "string") {
		return null;
	}

	// Handle case where there's no tag (no colon or colon is part of port number)
	const lastColonIndex = dockerImage.lastIndexOf(":");
	if (lastColonIndex === -1) {
		return dockerImage;
	}

	// Check if the part after the last colon looks like a tag (not a port number)
	// Port numbers are typically 1-5 digits, tags are usually longer or contain letters
	const afterColon = dockerImage.substring(lastColonIndex + 1);
	const isPortNumber = /^\d{1,5}$/.test(afterColon);

	// If it's a port number (like registry:5000/image), don't split
	if (isPortNumber) {
		return dockerImage;
	}

	// Otherwise, split at the last colon to get image name
	return dockerImage.substring(0, lastColonIndex);
}

/**
 * Return the last part of the image name, which is the tag
 * Example: "my-image" => null
 * Example: "my-image:latest" => "latest"
 * Example: "my-image:1.0.0" => "1.0.0"
 * Example: "myregistryhost:5000/fedora/httpd:version1.0" => "version1.0"
 * @link https://docs.docker.com/reference/cli/docker/image/tag/
 */
export function extractImageTag(dockerImage: string | null) {
	if (!dockerImage || typeof dockerImage !== "string") {
		return null;
	}

	const lastColonIndex = dockerImage.lastIndexOf(":");
	if (lastColonIndex === -1) {
		return "latest";
	}

	const afterColon = dockerImage.substring(lastColonIndex + 1);
	const isPortWithPath = /^\d{1,5}\//.test(afterColon);

	if (isPortWithPath) {
		return "latest";
	}

	return afterColon;
}

/**
 * Extract the image name (without tag) from webhook request
 * @link https://docs.docker.com/docker-hub/webhooks/#example-webhook-payload
 * @link https://docs.github.com/en/webhooks/webhook-events-and-payloads#registry_package
 */
export const extractImageNameFromRequest = (
	headers: any,
	body: any,
): string | null => {
	// GitHub Packages: registry_package events (container registry)
	const packageVersion = getPackageVersion(headers, body);
	if (packageVersion?.package_url) {
		const packageUrl = packageVersion.package_url;
		// Remove tag if present (everything after the last colon)
		if (packageUrl.includes(":")) {
			const lastColonIndex = packageUrl.lastIndexOf(":");
			// Check if it's a port number (like registry:5000/image)
			const afterColon = packageUrl.substring(lastColonIndex + 1);
			const isPortNumber = /^\d{1,5}$/.test(afterColon);
			if (isPortNumber) {
				return packageUrl;
			}
			return packageUrl.substring(0, lastColonIndex);
		}
		return packageUrl;
	}

	// Docker Hub
	if (headers["user-agent"]?.includes("Go-http-client")) {
		if (body.repository) {
			const repoName = body.repository.repo_name;
			return `${repoName}`;
		}
	}
	return null;
};

/**
 * @link https://docs.docker.com/docker-hub/webhooks/#example-webhook-payload
 * @link https://docs.github.com/en/webhooks/webhook-events-and-payloads#registry_package
 */
export const extractImageTagFromRequest = (
	headers: any,
	body: any,
): string | null => {
	// GitHub Packages: registry_package events (container registry)
	const packageVersion = getPackageVersion(headers, body);
	if (packageVersion) {
		// Try to get tag from container_metadata first (most reliable)
		// Only use it if it's not empty and not the same as the version (digest)
		const tagName = packageVersion.container_metadata?.tag?.name?.trim() || "";
		if (
			tagName &&
			tagName !== packageVersion.version &&
			!tagName.startsWith("sha256:")
		) {
			return tagName;
		}
		// Fallback: extract tag from package_url (e.g., "ghcr.io/owner/repo:tag")
		if (packageVersion.package_url) {
			const packageUrl = packageVersion.package_url;
			// Handle case where package_url ends with colon (no tag)
			if (packageUrl.endsWith(":")) {
				return null;
			}
			const tagMatch = packageUrl.match(/:([^:]+)$/);
			if (tagMatch?.[1]?.trim()) {
				return tagMatch[1].trim();
			}
		}
	}

	// Docker Hub
	if (headers["user-agent"]?.includes("Go-http-client")) {
		if (body.push_data && body.repository) {
			return body.push_data.tag;
		}
	}
	return null;
};

export const extractCommitMessage = (headers: any, body: any) => {
	// GitHub Packages: registry_package events (container tags)
	const githubEvent = headers["x-github-event"];
	if (githubEvent === "registry_package") {
		const packageVersion = getPackageVersion(headers, body);
		if (packageVersion) {
			if (packageVersion.package_url) {
				return `Docker GHCR image pushed: ${packageVersion.package_url}`;
			}
			return "Docker GHCR image pushed";
		}
		// If package_version is missing, fall through to default behavior
	}
	// GitHub
	if (headers["x-github-event"]) {
		return body.head_commit ? body.head_commit.message : "NEW COMMIT";
	}

	// GitLab
	if (headers["x-gitlab-event"]) {
		return body.commits && body.commits.length > 0
			? body.commits[0].message
			: "NEW COMMIT";
	}

	// Bitbucket
	if (headers["x-event-key"]?.includes("repo:push")) {
		return body.push.changes && body.push.changes.length > 0
			? body.push.changes[0].new.target.message
			: "NEW COMMIT";
	}

	// Gitea
	if (headers["x-gitea-event"]) {
		return body.commits && body.commits.length > 0
			? body.commits[0].message
			: "NEW COMMIT";
	}

	// Soft Serve
	if (headers["x-softserve-event"]) {
		return body.commits && body.commits.length > 0
			? body.commits[0].message
			: "NEW COMMIT";
	}

	if (headers["user-agent"]?.includes("Go-http-client")) {
		if (body.push_data && body.repository) {
			return `DockerHub image pushed: ${body.repository.repo_name}:${body.push_data.tag} by ${body.push_data.pusher}`;
		}
	}

	return "NEW CHANGES";
};

export const extractHash = (headers: any, body: any) => {
	// GitHub
	if (headers["x-github-event"]) {
		return body.head_commit ? body.head_commit.id : "";
	}

	// GitLab
	if (headers["x-gitlab-event"]) {
		return (
			body.checkout_sha ||
			(body.commits && body.commits.length > 0
				? body.commits[0].id
				: "NEW COMMIT")
		);
	}

	// Bitbucket
	if (headers["x-event-key"]?.includes("repo:push")) {
		return body.push.changes && body.push.changes.length > 0
			? body.push.changes[0].new.target.hash
			: "NEW COMMIT";
	}

	// Gitea
	if (headers["x-gitea-event"]) {
		return body.after || "NEW COMMIT";
	}

	// Soft Serve
	if (headers["x-softserve-event"]) {
		return body.after || "NEW COMMIT";
	}

	return "";
};

export const extractBranchName = (headers: any, body: any) => {
	if (headers["x-github-event"] || headers["x-gitea-event"]) {
		return body?.ref?.replace("refs/heads/", "");
	}

	if (
		headers["x-gitlab-event"] ||
		headers["x-softserve-event"]?.includes("push")
	) {
		return body?.ref ? body?.ref.replace("refs/heads/", "") : null;
	}

	if (headers["x-event-key"]?.includes("repo:push")) {
		return body?.push?.changes[0]?.new?.name;
	}

	return null;
};

export const getProviderByHeader = (headers: any) => {
	if (headers["x-github-event"]) {
		return "github";
	}

	if (headers["x-gitea-event"]) {
		return "gitea";
	}

	if (headers["x-gitlab-event"]) {
		return "gitlab";
	}

	if (headers["x-event-key"]?.includes("repo:push")) {
		return "bitbucket";
	}

	if (headers["x-softserve-event"]) {
		return "soft-serve";
	}

	return null;
};

export const extractCommittedPaths = async (
	body: any,
	bitbucket: Bitbucket | null,
	repository: string,
) => {
	const changes = body.push?.changes || [];

	const commitHashes = changes
		.map((change: any) => change.new?.target?.hash)
		.filter(Boolean);
	const committedPaths: string[] = [];
	const username =
		bitbucket?.bitbucketWorkspaceName || bitbucket?.bitbucketUsername || "";
	for (const commit of commitHashes) {
		const url = `https://api.bitbucket.org/2.0/repositories/${username}/${repository}/diffstat/${commit}`;
		try {
			const response = await fetch(url, {
				headers: getBitbucketHeaders(bitbucket!),
			});
			const data = await response.json();
			for (const value of data.values) {
				if (value?.new?.path) committedPaths.push(value.new.path);
			}
		} catch (error) {
			console.error(
				`Error fetching Bitbucket diffstat for commit ${commit}:`,
				error instanceof Error ? error.message : "Unknown error",
			);

			return [];
		}
	}

	return committedPaths;
};
