import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { GitDelivery } from "../db/schema";

export type GitWebhookProvider = GitDelivery["provider"];
export type GitWebhookHeaders = Record<string, string | string[] | undefined>;

export type NormalizedGitWebhookEvent = {
	provider: GitWebhookProvider;
	eventType: "push" | "tag" | "pull_request" | "registry" | "unknown";
	action?: string;
	repositoryOwner?: string;
	repositoryName?: string;
	branch?: string;
	sourceBranch?: string;
	commitSha?: string;
	commitMessage?: string;
	changedPaths: string[];
	pullRequestId?: string;
	pullRequestNumber?: number;
	pullRequestTitle?: string;
	pullRequestUrl?: string;
	pullRequestAuthor?: string;
	pullRequestAuthorId?: string;
	closed: boolean;
};

const firstHeader = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value;

const normalizeHeaderName = (headers: GitWebhookHeaders, name: string) =>
	firstHeader(headers[name] ?? headers[name.toLowerCase()]);

export const gitWebhookPayloadHash = (rawBody: Buffer | string) =>
	createHash("sha256").update(rawBody).digest("hex");

export const gitWebhookProviderScopeHash = (scope: string) =>
	createHash("sha256").update(scope).digest("hex");

export const detectGitWebhookProvider = (
	headers: GitWebhookHeaders,
): GitWebhookProvider => {
	if (normalizeHeaderName(headers, "x-github-event")) return "github";
	if (normalizeHeaderName(headers, "x-gitlab-event")) return "gitlab";
	if (normalizeHeaderName(headers, "x-gitea-event")) return "gitea";
	if (normalizeHeaderName(headers, "x-event-key")) return "bitbucket";
	if (normalizeHeaderName(headers, "x-softserve-event")) return "soft_serve";
	if (normalizeHeaderName(headers, "x-docker-hub-signature")) return "docker";
	return "generic";
};

const safeEqual = (left: string, right: string) => {
	const leftBuffer = Buffer.from(left, "utf8");
	const rightBuffer = Buffer.from(right, "utf8");
	return (
		leftBuffer.length === rightBuffer.length &&
		timingSafeEqual(leftBuffer, rightBuffer)
	);
};

const verifyHmac = ({
	rawBody,
	secret,
	signature,
	prefix = "sha256=",
}: {
	rawBody: Buffer | string;
	secret: string;
	signature?: string;
	prefix?: string;
}) => {
	if (!signature) return false;
	const digest = createHmac("sha256", secret).update(rawBody).digest("hex");
	const supplied = signature.startsWith(prefix)
		? signature.slice(prefix.length)
		: signature;
	return safeEqual(digest.toLowerCase(), supplied.toLowerCase());
};

export const verifyGitWebhookSignature = ({
	provider,
	headers,
	rawBody,
	secret,
	required = true,
}: {
	provider: GitWebhookProvider;
	headers: GitWebhookHeaders;
	rawBody: Buffer | string;
	secret: string;
	required?: boolean;
}): { verified: boolean; algorithm: string | null } => {
	if (!secret) return { verified: false, algorithm: null };
	if (provider === "gitlab") {
		const token = normalizeHeaderName(headers, "x-gitlab-token");
		return {
			verified: token ? safeEqual(secret, token) : !required,
			algorithm: token ? "shared-token" : null,
		};
	}
	const signature =
		provider === "github"
			? normalizeHeaderName(headers, "x-hub-signature-256")
			: provider === "gitea"
				? normalizeHeaderName(headers, "x-gitea-signature")
				: provider === "bitbucket"
					? normalizeHeaderName(headers, "x-hub-signature")
					: provider === "soft_serve"
						? normalizeHeaderName(headers, "x-softserve-signature")
						: provider === "docker"
							? normalizeHeaderName(headers, "x-docker-hub-signature")
							: normalizeHeaderName(headers, "x-vlyv-signature");
	if (!signature && !required) {
		return { verified: false, algorithm: null };
	}
	return {
		verified: verifyHmac({ rawBody, secret, signature }),
		algorithm: signature ? "hmac-sha256" : null,
	};
};

const compactStrings = (values: unknown[]) =>
	[
		...new Set(
			values.filter(
				(value): value is string =>
					typeof value === "string" && value.trim().length > 0,
			),
		),
	].slice(0, 10_000);

const commitPaths = (commits: unknown) => {
	if (!Array.isArray(commits)) return [];
	return compactStrings(
		commits.flatMap((commit) => {
			if (!commit || typeof commit !== "object") return [];
			const value = commit as Record<string, unknown>;
			return [value.added, value.modified, value.removed].flatMap((paths) =>
				Array.isArray(paths) ? paths : [],
			);
		}),
	);
};

const stripBranchRef = (value: unknown) =>
	typeof value === "string" ? value.replace(/^refs\/heads\//, "") : undefined;

const stringValue = (value: unknown) =>
	typeof value === "string" && value.trim() ? value : undefined;

const numberValue = (value: unknown) => {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) {
		return Number.parseInt(value, 10);
	}
	return undefined;
};

export const normalizeGitWebhookEvent = ({
	provider,
	headers,
	body,
}: {
	provider: GitWebhookProvider;
	headers: GitWebhookHeaders;
	body: Record<string, any>;
}): NormalizedGitWebhookEvent => {
	if (provider === "github") {
		const event = normalizeHeaderName(headers, "x-github-event");
		const repositoryOwner =
			stringValue(body.repository?.owner?.login) ??
			stringValue(body.repository?.owner?.name);
		if (event === "pull_request") {
			const pullRequest = body.pull_request ?? {};
			const action = stringValue(body.action) ?? "unknown";
			return {
				provider,
				eventType: "pull_request",
				action,
				repositoryOwner,
				repositoryName: stringValue(body.repository?.name),
				branch: stringValue(pullRequest.base?.ref),
				sourceBranch: stringValue(pullRequest.head?.ref),
				commitSha: stringValue(pullRequest.head?.sha),
				commitMessage: stringValue(pullRequest.title),
				changedPaths: [],
				pullRequestId: String(pullRequest.id ?? pullRequest.number ?? ""),
				pullRequestNumber: numberValue(pullRequest.number),
				pullRequestTitle: stringValue(pullRequest.title),
				pullRequestUrl: stringValue(pullRequest.html_url),
				pullRequestAuthor: stringValue(pullRequest.user?.login),
				pullRequestAuthorId: stringValue(pullRequest.user?.node_id),
				closed: ["closed"].includes(action),
			};
		}
		const tag =
			typeof body.ref === "string" && body.ref.startsWith("refs/tags/");
		return {
			provider,
			eventType:
				event === "registry_package" ? "registry" : tag ? "tag" : "push",
			action: stringValue(body.action),
			repositoryOwner,
			repositoryName: stringValue(body.repository?.name),
			branch: tag
				? stringValue(body.ref)?.replace(/^refs\/tags\//, "")
				: stripBranchRef(body.ref),
			commitSha: stringValue(body.after) ?? stringValue(body.head_commit?.id),
			commitMessage: stringValue(body.head_commit?.message),
			changedPaths: commitPaths(body.commits),
			closed: false,
		};
	}

	if (provider === "gitlab") {
		const event = (
			normalizeHeaderName(headers, "x-gitlab-event") ?? ""
		).toLowerCase();
		if (event.includes("merge request")) {
			const attributes = body.object_attributes ?? {};
			const action =
				stringValue(attributes.action) ??
				stringValue(body.event_type) ??
				"unknown";
			return {
				provider,
				eventType: "pull_request",
				action,
				repositoryOwner:
					stringValue(body.project?.namespace) ??
					stringValue(body.project?.path_with_namespace)
						?.split("/")
						.slice(0, -1)
						.join("/"),
				repositoryName: stringValue(body.project?.path),
				branch: stringValue(attributes.target_branch),
				sourceBranch: stringValue(attributes.source_branch),
				commitSha:
					stringValue(attributes.last_commit?.id) ??
					stringValue(body.object_attributes?.last_commit?.id),
				commitMessage: stringValue(attributes.title),
				changedPaths: [],
				pullRequestId: String(attributes.id ?? attributes.iid ?? ""),
				pullRequestNumber: numberValue(attributes.iid),
				pullRequestTitle: stringValue(attributes.title),
				pullRequestUrl: stringValue(attributes.url),
				pullRequestAuthor: stringValue(body.user?.username),
				pullRequestAuthorId:
					body.user?.id === undefined ? undefined : String(body.user.id),
				closed: ["close", "closed", "merge", "merged"].includes(action),
			};
		}
		const tag =
			event.includes("tag") || String(body.ref ?? "").startsWith("refs/tags/");
		const path = stringValue(body.project?.path_with_namespace);
		return {
			provider,
			eventType: tag ? "tag" : "push",
			repositoryOwner:
				stringValue(body.project?.namespace) ??
				path?.split("/").slice(0, -1).join("/"),
			repositoryName:
				stringValue(body.project?.path) ?? path?.split("/").at(-1),
			branch: tag
				? stringValue(body.ref)?.replace(/^refs\/tags\//, "")
				: stripBranchRef(body.ref),
			commitSha: stringValue(body.checkout_sha) ?? stringValue(body.after),
			commitMessage: stringValue(body.commits?.[0]?.message),
			changedPaths: commitPaths(body.commits),
			closed: false,
		};
	}

	if (provider === "gitea") {
		const event = normalizeHeaderName(headers, "x-gitea-event");
		if (event === "pull_request") {
			const pullRequest = body.pull_request ?? {};
			const action = stringValue(body.action) ?? "unknown";
			return {
				provider,
				eventType: "pull_request",
				action,
				repositoryOwner: stringValue(body.repository?.owner?.login),
				repositoryName: stringValue(body.repository?.name),
				branch: stringValue(pullRequest.base?.ref),
				sourceBranch: stringValue(pullRequest.head?.ref),
				commitSha: stringValue(pullRequest.head?.sha),
				commitMessage: stringValue(pullRequest.title),
				changedPaths: [],
				pullRequestId: String(pullRequest.id ?? pullRequest.number ?? ""),
				pullRequestNumber: numberValue(pullRequest.number),
				pullRequestTitle: stringValue(pullRequest.title),
				pullRequestUrl: stringValue(pullRequest.html_url),
				pullRequestAuthor: stringValue(pullRequest.user?.login),
				pullRequestAuthorId:
					pullRequest.user?.id === undefined
						? undefined
						: String(pullRequest.user.id),
				closed: ["closed"].includes(action),
			};
		}
		return {
			provider,
			eventType: String(body.ref ?? "").startsWith("refs/tags/")
				? "tag"
				: "push",
			repositoryOwner: stringValue(body.repository?.owner?.login),
			repositoryName: stringValue(body.repository?.name),
			branch: String(body.ref ?? "").startsWith("refs/tags/")
				? stringValue(body.ref)?.replace(/^refs\/tags\//, "")
				: stripBranchRef(body.ref),
			commitSha: stringValue(body.after),
			commitMessage: stringValue(body.commits?.[0]?.message),
			changedPaths: commitPaths(body.commits),
			closed: false,
		};
	}

	if (provider === "bitbucket") {
		const event = normalizeHeaderName(headers, "x-event-key") ?? "";
		if (event.startsWith("pullrequest:")) {
			const pullRequest = body.pullrequest ?? {};
			const action = event.replace("pullrequest:", "");
			return {
				provider,
				eventType: "pull_request",
				action,
				repositoryOwner:
					stringValue(body.repository?.workspace?.slug) ??
					stringValue(body.repository?.owner?.nickname),
				repositoryName: stringValue(body.repository?.slug),
				branch: stringValue(pullRequest.destination?.branch?.name),
				sourceBranch: stringValue(pullRequest.source?.branch?.name),
				commitSha: stringValue(pullRequest.source?.commit?.hash),
				commitMessage: stringValue(pullRequest.title),
				changedPaths: [],
				pullRequestId: String(pullRequest.id ?? ""),
				pullRequestNumber: numberValue(pullRequest.id),
				pullRequestTitle: stringValue(pullRequest.title),
				pullRequestUrl: stringValue(pullRequest.links?.html?.href),
				pullRequestAuthor:
					stringValue(body.actor?.nickname) ??
					stringValue(body.actor?.display_name),
				pullRequestAuthorId:
					stringValue(body.actor?.uuid) ?? stringValue(body.actor?.account_id),
				closed: ["fulfilled", "rejected"].includes(action),
			};
		}
		const change = body.push?.changes?.[0] ?? {};
		return {
			provider,
			eventType: change.new?.type === "tag" ? "tag" : "push",
			repositoryOwner:
				stringValue(body.repository?.workspace?.slug) ??
				stringValue(body.repository?.owner?.nickname),
			repositoryName: stringValue(body.repository?.slug),
			branch: stringValue(change.new?.name),
			commitSha: stringValue(change.new?.target?.hash),
			commitMessage: stringValue(change.new?.target?.message),
			changedPaths: [],
			closed: false,
		};
	}

	if (provider === "soft_serve") {
		return {
			provider,
			eventType: "push",
			repositoryOwner: stringValue(body.repository?.owner),
			repositoryName: stringValue(body.repository?.name),
			branch: stripBranchRef(body.ref),
			commitSha: stringValue(body.after),
			commitMessage: stringValue(body.commits?.[0]?.message),
			changedPaths: commitPaths(body.commits),
			closed: false,
		};
	}

	return {
		provider,
		eventType: provider === "docker" ? "registry" : "unknown",
		repositoryOwner: stringValue(body.repository?.namespace),
		repositoryName:
			stringValue(body.repository?.repo_name) ??
			stringValue(body.repository?.name),
		commitSha: stringValue(body.push_data?.tag),
		commitMessage: stringValue(body.push_data?.pusher),
		changedPaths: [],
		closed: false,
	};
};

export const extractGitWebhookDeliveryId = ({
	provider,
	headers,
	payloadHash,
	scopeHash,
	eventType,
}: {
	provider: GitWebhookProvider;
	headers: GitWebhookHeaders;
	payloadHash: string;
	scopeHash: string;
	eventType: string;
}) => {
	const candidate =
		(provider === "github"
			? normalizeHeaderName(headers, "x-github-delivery")
			: provider === "gitlab"
				? normalizeHeaderName(headers, "x-gitlab-event-uuid")
				: provider === "gitea"
					? normalizeHeaderName(headers, "x-gitea-delivery")
					: provider === "bitbucket"
						? normalizeHeaderName(headers, "x-request-uuid")
						: normalizeHeaderName(headers, "idempotency-key")) ?? "";
	if (candidate.trim()) return candidate.trim().slice(0, 255);
	return createHash("sha256")
		.update(`${provider}:${scopeHash}:${eventType}:${payloadHash}`)
		.digest("hex");
};
