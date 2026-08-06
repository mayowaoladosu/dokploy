import { createHash } from "node:crypto";
import { getBitbucketHeaders } from "../utils/providers/bitbucket";
import { refreshGiteaToken } from "../utils/providers/gitea";
import {
	authGithub,
	checkUserRepositoryPermissions,
} from "../utils/providers/github";
import { refreshGitlabToken } from "../utils/providers/gitlab";
import { findBitbucketById } from "./bitbucket";
import {
	findGitDeliveryTarget,
	markGitDeliveryReportFailed,
	markGitDeliveryReportSynced,
	prepareGitDeliveryTargetForReport,
} from "./git-delivery";
import type { GitWebhookProvider } from "./git-webhook";
import { findGiteaById } from "./gitea";
import { findGithubById } from "./github";
import { findGitlabById } from "./gitlab";

const terminalStatuses = new Set([
	"succeeded",
	"failed",
	"cancelled",
	"ignored",
]);

const gitDeliveryContext = (
	target: Pick<
		Awaited<ReturnType<typeof findGitDeliveryTarget>>,
		| "applicationId"
		| "composeId"
		| "previewDeploymentId"
		| "targetKey"
		| "targetName"
	>,
) => {
	const identity =
		target.previewDeploymentId ??
		target.applicationId ??
		target.composeId ??
		target.targetKey;
	const suffix = createHash("sha256")
		.update(identity)
		.digest("hex")
		.slice(0, 10);
	const name = target.targetName
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 75);
	return `vlyv/${name || "deployment"}-${suffix}`;
};

export const gitDeliveryReportValues = (status: string) => {
	if (status === "succeeded" || status === "ignored") {
		return {
			state: "success" as const,
			checkStatus: "completed" as const,
			conclusion: "success" as const,
			label: "Deployment succeeded",
		};
	}
	if (status === "failed") {
		return {
			state: "failure" as const,
			checkStatus: "completed" as const,
			conclusion: "failure" as const,
			label: "Deployment failed",
		};
	}
	if (status === "cancelled") {
		return {
			state: "error" as const,
			checkStatus: "completed" as const,
			conclusion: "cancelled" as const,
			label: "Deployment cancelled",
		};
	}
	return {
		state: "pending" as const,
		checkStatus: "in_progress" as const,
		conclusion: undefined,
		label:
			status === "running" ? "Deployment in progress" : "Deployment queued",
	};
};

const reportBody = ({
	targetId,
	name,
	label,
	detailsUrl,
}: {
	targetId: string;
	name: string;
	label: string;
	detailsUrl?: string | null;
}) =>
	[
		"### vlyv deployment",
		"",
		"| Service | Status |",
		"| --- | --- |",
		`| ${name.replaceAll("|", "\\|")} | ${label} |`,
		detailsUrl ? `\n[View deployment](${detailsUrl})` : "",
		`\n<!-- vlyv-git-delivery-target:${targetId} -->`,
	].join("\n");

const parseJson = async (response: Response) => {
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`Git provider API returned HTTP ${response.status}`);
	}
	return text ? JSON.parse(text) : {};
};

const reportGithub = async (
	target: Awaited<ReturnType<typeof findGitDeliveryTarget>>,
) => {
	const { delivery } = target;
	if (
		!delivery.providerConnectionId ||
		!delivery.repositoryOwner ||
		!delivery.repositoryName ||
		!delivery.commitSha
	) {
		return {};
	}
	const provider = await findGithubById(delivery.providerConnectionId);
	const octokit = authGithub(provider);
	const values = gitDeliveryReportValues(target.status);
	const context = gitDeliveryContext(target);
	const statusInput = {
		owner: delivery.repositoryOwner,
		repo: delivery.repositoryName,
		sha: delivery.commitSha,
		state: values.state,
		context,
		description: values.label.slice(0, 140),
		target_url: target.detailsUrl ?? undefined,
	};
	await octokit.rest.repos.createCommitStatus(statusInput);

	let externalCheckId = target.externalCheckId ?? undefined;
	const output = {
		title: values.label,
		summary: `${target.targetName}: ${values.label}`,
	};
	if (!externalCheckId) {
		const checks = await octokit.rest.checks.listForRef({
			owner: delivery.repositoryOwner,
			repo: delivery.repositoryName,
			ref: delivery.commitSha,
			check_name: context,
			per_page: 100,
		});
		const existing = checks.data.check_runs.find(
			(check) => check.name === context,
		);
		if (existing) externalCheckId = String(existing.id);
	}
	if (externalCheckId) {
		await octokit.rest.checks.update({
			owner: delivery.repositoryOwner,
			repo: delivery.repositoryName,
			check_run_id: Number.parseInt(externalCheckId, 10),
			status: values.checkStatus,
			conclusion: values.conclusion,
			details_url: target.detailsUrl ?? undefined,
			output,
		});
	} else {
		const created = await octokit.rest.checks.create({
			owner: delivery.repositoryOwner,
			repo: delivery.repositoryName,
			name: context,
			head_sha: delivery.commitSha,
			status: values.checkStatus,
			conclusion: values.conclusion,
			details_url: target.detailsUrl ?? undefined,
			output,
		});
		externalCheckId = String(created.data.id);
	}

	let externalCommentId = target.externalCommentId ?? undefined;
	const pullRequestNumber = delivery.metadata.pullRequestNumber;
	if (pullRequestNumber) {
		if (!externalCommentId) {
			const comments = await octokit.paginate(octokit.rest.issues.listComments, {
				owner: delivery.repositoryOwner,
				repo: delivery.repositoryName,
				issue_number: pullRequestNumber,
				per_page: 100,
			});
			const marker = `vlyv-git-delivery-target:${target.gitDeliveryTargetId}`;
			const existing = comments.find((comment) =>
				comment.body?.includes(marker),
			);
			if (existing) externalCommentId = String(existing.id);
		}
		const body = reportBody({
			targetId: target.gitDeliveryTargetId,
			name: target.targetName,
			label: values.label,
			detailsUrl: target.detailsUrl,
		});
		if (externalCommentId && /^\d+$/.test(externalCommentId)) {
			await octokit.rest.issues.updateComment({
				owner: delivery.repositoryOwner,
				repo: delivery.repositoryName,
				comment_id: Number.parseInt(externalCommentId, 10),
				body,
			});
		} else {
			const comment = await octokit.rest.issues.createComment({
				owner: delivery.repositoryOwner,
				repo: delivery.repositoryName,
				issue_number: pullRequestNumber,
				body,
			});
			externalCommentId = String(comment.data.id);
		}
	}
	return { externalCheckId, externalCommentId };
};

const gitlabRequest = async ({
	connectionId,
	path,
	method = "POST",
	body,
}: {
	connectionId: string;
	path: string;
	method?: "GET" | "POST" | "PUT";
	body: Record<string, unknown>;
}) => {
	await refreshGitlabToken(connectionId);
	const provider = await findGitlabById(connectionId);
	const base = new URL(provider.gitlabInternalUrl || provider.gitlabUrl);
	const response = await fetch(new URL(path.replace(/^\//, ""), `${base}/`), {
		method,
		headers: {
			Authorization: `Bearer ${provider.accessToken}`,
			"Content-Type": "application/json",
		},
		body: method === "GET" ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	return parseJson(response);
};

const reportGitlab = async (
	target: Awaited<ReturnType<typeof findGitDeliveryTarget>>,
) => {
	const { delivery } = target;
	const projectId = delivery.metadata.providerProjectId;
	if (!delivery.providerConnectionId || !projectId || !delivery.commitSha) {
		return {};
	}
	const values = gitDeliveryReportValues(target.status);
	const context = gitDeliveryContext(target);
	await gitlabRequest({
		connectionId: delivery.providerConnectionId,
		path: `/api/v4/projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(delivery.commitSha)}`,
		body: {
			state:
				values.state === "failure"
					? "failed"
					: values.state === "error"
						? "canceled"
						: values.state,
			name: context,
			description: values.label,
			target_url: target.detailsUrl,
		},
	});
	let externalCommentId = target.externalCommentId ?? undefined;
	const pullRequestNumber = delivery.metadata.pullRequestNumber;
	if (pullRequestNumber) {
		if (!externalCommentId) {
			const notes = await gitlabRequest({
				connectionId: delivery.providerConnectionId,
				path: `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${pullRequestNumber}/notes?per_page=100&order_by=created_at&sort=desc`,
				method: "GET",
				body: {},
			});
			const marker = `vlyv-git-delivery-target:${target.gitDeliveryTargetId}`;
			const existing = Array.isArray(notes)
				? notes.find(
						(note) =>
							typeof note?.body === "string" && note.body.includes(marker),
					)
				: undefined;
			if (existing?.id !== undefined) externalCommentId = String(existing.id);
		}
		const body = reportBody({
			targetId: target.gitDeliveryTargetId,
			name: target.targetName,
			label: values.label,
			detailsUrl: target.detailsUrl,
		});
		if (externalCommentId) {
			await gitlabRequest({
				connectionId: delivery.providerConnectionId,
				path: `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${pullRequestNumber}/notes/${encodeURIComponent(externalCommentId)}`,
				method: "PUT",
				body: { body },
			});
		} else {
			const comment = await gitlabRequest({
				connectionId: delivery.providerConnectionId,
				path: `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${pullRequestNumber}/notes`,
				body: { body },
			});
			externalCommentId = String(comment.id ?? "");
		}
	}
	return { externalCommentId };
};

const giteaRequest = async ({
	connectionId,
	path,
	method = "POST",
	body,
}: {
	connectionId: string;
	path: string;
	method?: "GET" | "POST" | "PATCH";
	body: Record<string, unknown>;
}) => {
	const token = await refreshGiteaToken(connectionId);
	const provider = await findGiteaById(connectionId);
	if (!token) throw new Error("Gitea access token is unavailable");
	const base = new URL(provider.giteaInternalUrl || provider.giteaUrl);
	const response = await fetch(new URL(path.replace(/^\//, ""), `${base}/`), {
		method,
		headers: {
			Authorization: `token ${token}`,
			"Content-Type": "application/json",
		},
		body: method === "GET" ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	return parseJson(response);
};

const reportGitea = async (
	target: Awaited<ReturnType<typeof findGitDeliveryTarget>>,
) => {
	const { delivery } = target;
	if (
		!delivery.providerConnectionId ||
		!delivery.repositoryOwner ||
		!delivery.repositoryName ||
		!delivery.commitSha
	) {
		return {};
	}
	const values = gitDeliveryReportValues(target.status);
	const repo = `${encodeURIComponent(delivery.repositoryOwner)}/${encodeURIComponent(delivery.repositoryName)}`;
	await giteaRequest({
		connectionId: delivery.providerConnectionId,
		path: `/api/v1/repos/${repo}/statuses/${encodeURIComponent(delivery.commitSha)}`,
		body: {
			state: values.state,
			context: gitDeliveryContext(target),
			description: values.label,
			target_url: target.detailsUrl,
		},
	});
	let externalCommentId = target.externalCommentId ?? undefined;
	const pullRequestNumber = delivery.metadata.pullRequestNumber;
	if (pullRequestNumber) {
		if (!externalCommentId) {
			const comments = await giteaRequest({
				connectionId: delivery.providerConnectionId,
				path: `/api/v1/repos/${repo}/issues/${pullRequestNumber}/comments?limit=100`,
				method: "GET",
				body: {},
			});
			const marker = `vlyv-git-delivery-target:${target.gitDeliveryTargetId}`;
			const existing = Array.isArray(comments)
				? comments.find(
						(comment) =>
							typeof comment?.body === "string" &&
							comment.body.includes(marker),
					)
				: undefined;
			if (existing?.id !== undefined) externalCommentId = String(existing.id);
		}
		const body = reportBody({
			targetId: target.gitDeliveryTargetId,
			name: target.targetName,
			label: values.label,
			detailsUrl: target.detailsUrl,
		});
		if (externalCommentId) {
			await giteaRequest({
				connectionId: delivery.providerConnectionId,
				path: `/api/v1/repos/${repo}/issues/comments/${encodeURIComponent(externalCommentId)}`,
				method: "PATCH",
				body: { body },
			});
		} else {
			const comment = await giteaRequest({
				connectionId: delivery.providerConnectionId,
				path: `/api/v1/repos/${repo}/issues/${pullRequestNumber}/comments`,
				body: { body },
			});
			externalCommentId = String(comment.id ?? "");
		}
	}
	return { externalCommentId };
};

const bitbucketRequest = async ({
	connectionId,
	path,
	method = "POST",
	body,
	allowNotFound = false,
}: {
	connectionId: string;
	path: string;
	method?: "GET" | "POST" | "PUT";
	body: Record<string, unknown>;
	allowNotFound?: boolean;
}) => {
	const provider = await findBitbucketById(connectionId);
	const response = await fetch(
		new URL(path.replace(/^\//, ""), "https://api.bitbucket.org/2.0/"),
		{
			method,
			headers: {
				...getBitbucketHeaders(provider),
				"Content-Type": "application/json",
			},
			body: method === "GET" ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		},
	);
	if (allowNotFound && response.status === 404) return null;
	return parseJson(response);
};

const reportBitbucket = async (
	target: Awaited<ReturnType<typeof findGitDeliveryTarget>>,
) => {
	const { delivery } = target;
	if (
		!delivery.providerConnectionId ||
		!delivery.repositoryOwner ||
		!delivery.repositoryName ||
		!delivery.commitSha
	) {
		return {};
	}
	const values = gitDeliveryReportValues(target.status);
	const repo = `repositories/${encodeURIComponent(delivery.repositoryOwner)}/${encodeURIComponent(delivery.repositoryName)}`;
	const statusKey = `vlyv-${target.gitDeliveryTargetId}`.slice(0, 40);
	const existingStatus = await bitbucketRequest({
		connectionId: delivery.providerConnectionId,
		path: `/${repo}/commit/${encodeURIComponent(delivery.commitSha)}/statuses/build/${encodeURIComponent(statusKey)}`,
		method: "GET",
		body: {},
		allowNotFound: true,
	});
	await bitbucketRequest({
		connectionId: delivery.providerConnectionId,
		path: existingStatus
			? `/${repo}/commit/${encodeURIComponent(delivery.commitSha)}/statuses/build/${encodeURIComponent(statusKey)}`
			: `/${repo}/commit/${encodeURIComponent(delivery.commitSha)}/statuses/build`,
		method: existingStatus ? "PUT" : "POST",
		body: {
			key: statusKey,
			name: target.targetName,
			state:
				values.state === "success"
					? "SUCCESSFUL"
					: values.state === "pending"
						? "INPROGRESS"
						: "FAILED",
			description: values.label,
			url: target.detailsUrl,
		},
	});
	let externalCommentId = target.externalCommentId ?? undefined;
	const pullRequestNumber = delivery.metadata.pullRequestNumber;
	if (pullRequestNumber) {
		if (!externalCommentId) {
			const comments = await bitbucketRequest({
				connectionId: delivery.providerConnectionId,
				path: `/${repo}/pullrequests/${pullRequestNumber}/comments?pagelen=100&sort=-created_on`,
				method: "GET",
				body: {},
			});
			const marker = `vlyv-git-delivery-target:${target.gitDeliveryTargetId}`;
			const existing = Array.isArray(comments?.values)
				? comments.values.find((comment: { content?: { raw?: string } }) =>
						comment.content?.raw?.includes(marker),
					)
				: undefined;
			if (existing?.id !== undefined) externalCommentId = String(existing.id);
		}
		const content = {
			raw: reportBody({
				targetId: target.gitDeliveryTargetId,
				name: target.targetName,
				label: values.label,
				detailsUrl: target.detailsUrl,
			}),
		};
		if (externalCommentId) {
			await bitbucketRequest({
				connectionId: delivery.providerConnectionId,
				path: `/${repo}/pullrequests/${pullRequestNumber}/comments/${encodeURIComponent(externalCommentId)}`,
				method: "PUT",
				body: { content },
			});
		} else {
			const comment = await bitbucketRequest({
				connectionId: delivery.providerConnectionId,
				path: `/${repo}/pullrequests/${pullRequestNumber}/comments`,
				body: { content },
			});
			externalCommentId = String(comment.id ?? "");
		}
	}
	return { externalCommentId };
};

export const synchronizeGitDeliveryTargetReport = async (
	gitDeliveryTargetId: string,
) => {
	if (!(await prepareGitDeliveryTargetForReport(gitDeliveryTargetId))) {
		return false;
	}
	const target = await findGitDeliveryTarget(gitDeliveryTargetId);
	try {
		const result =
			target.delivery.provider === "github"
				? await reportGithub(target)
				: target.delivery.provider === "gitlab"
					? await reportGitlab(target)
					: target.delivery.provider === "gitea"
						? await reportGitea(target)
						: target.delivery.provider === "bitbucket"
							? await reportBitbucket(target)
							: {};
		await markGitDeliveryReportSynced(gitDeliveryTargetId, {
			...result,
			observedStatus: target.status,
		});
		return true;
	} catch (error) {
		await markGitDeliveryReportFailed(gitDeliveryTargetId, error);
		throw error;
	}
};

export const verifyGitPullRequestAuthor = async ({
	provider,
	providerConnectionId,
	repositoryOwner,
	repositoryName,
	author,
	authorId,
	providerProjectId,
}: {
	provider: GitWebhookProvider;
	providerConnectionId: string;
	repositoryOwner: string;
	repositoryName: string;
	author: string;
	authorId?: string;
	providerProjectId?: string;
}) => {
	if (provider === "github") {
		const github = await findGithubById(providerConnectionId);
		return (
			await checkUserRepositoryPermissions(
				github,
				repositoryOwner,
				repositoryName,
				author,
			)
		).hasWriteAccess;
	}
	if (provider === "gitlab") {
		if (!providerProjectId || !authorId) return false;
		await refreshGitlabToken(providerConnectionId);
		const gitlab = await findGitlabById(providerConnectionId);
		const base = new URL(gitlab.gitlabInternalUrl || gitlab.gitlabUrl);
		const response = await fetch(
			new URL(
				`api/v4/projects/${encodeURIComponent(providerProjectId)}/members/all/${encodeURIComponent(authorId)}`,
				`${base}/`,
			),
			{
				headers: { Authorization: `Bearer ${gitlab.accessToken}` },
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) return false;
		const member = (await response.json()) as { access_level?: number };
		return (member.access_level ?? 0) >= 30;
	}
	if (provider === "gitea") {
		const token = await refreshGiteaToken(providerConnectionId);
		const gitea = await findGiteaById(providerConnectionId);
		if (!token) return false;
		const base = new URL(gitea.giteaInternalUrl || gitea.giteaUrl);
		const response = await fetch(
			new URL(
				`api/v1/repos/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/collaborators/${encodeURIComponent(author)}/permission`,
				`${base}/`,
			),
			{
				headers: { Authorization: `token ${token}` },
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) return false;
		const permission = (await response.json()) as { permission?: string };
		return ["write", "admin", "owner"].includes(permission.permission ?? "");
	}
	if (provider === "bitbucket") {
		if (!authorId) return false;
		const bitbucket = await findBitbucketById(providerConnectionId);
		const response = await fetch(
			`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}/permissions-config/users/${encodeURIComponent(authorId.replace(/[{}]/g, ""))}`,
			{
				headers: getBitbucketHeaders(bitbucket),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) return false;
		const permission = (await response.json()) as { permission?: string };
		return ["write", "admin"].includes(permission.permission ?? "");
	}
	return false;
};

export const isTerminalGitDeliveryTarget = (status: string) =>
	terminalStatuses.has(status);
