import { createHmac } from "node:crypto";
import {
	detectGitWebhookProvider,
	extractGitWebhookDeliveryId,
	gitWebhookPayloadHash,
	gitWebhookProviderScopeHash,
	normalizeGitWebhookEvent,
	verifyGitWebhookSignature,
} from "@dokploy/server/services/git-webhook";
import { describe, expect, it } from "vitest";

const rawBody = Buffer.from(JSON.stringify({ ref: "refs/heads/main" }));
const digest = createHmac("sha256", "webhook-secret")
	.update(rawBody)
	.digest("hex");

describe("Git webhook authentication", () => {
	it.each([
		["github" as const, { "x-hub-signature-256": `sha256=${digest}` }],
		["gitlab" as const, { "x-gitlab-token": "webhook-secret" }],
		["gitea" as const, { "x-gitea-signature": digest }],
		["bitbucket" as const, { "x-hub-signature": `sha256=${digest}` }],
	])("verifies signed %s deliveries", (provider, headers) => {
		expect(
			verifyGitWebhookSignature({
				provider,
				headers,
				rawBody,
				secret: "webhook-secret",
			}),
		).toMatchObject({ verified: true });
	});

	it("rejects payload tampering with a timing-safe comparison", () => {
		expect(
			verifyGitWebhookSignature({
				provider: "github",
				headers: { "x-hub-signature-256": `sha256=${digest}` },
				rawBody: Buffer.from('{"ref":"refs/heads/other"}'),
				secret: "webhook-secret",
			}),
		).toMatchObject({ verified: false });
	});

	it("detects all supported provider headers", () => {
		expect(detectGitWebhookProvider({ "x-github-event": "push" })).toBe(
			"github",
		);
		expect(detectGitWebhookProvider({ "x-gitlab-event": "Push Hook" })).toBe(
			"gitlab",
		);
		expect(detectGitWebhookProvider({ "x-gitea-event": "push" })).toBe("gitea");
		expect(detectGitWebhookProvider({ "x-event-key": "repo:push" })).toBe(
			"bitbucket",
		);
	});

	it("uses provider IDs and a scoped payload fallback for deduplication", () => {
		const payloadHash = gitWebhookPayloadHash(rawBody);
		const scopeHash = gitWebhookProviderScopeHash("installation:123");
		expect(
			extractGitWebhookDeliveryId({
				provider: "github",
				headers: { "x-github-delivery": "delivery-1" },
				payloadHash,
				scopeHash,
				eventType: "push",
			}),
		).toBe("delivery-1");
		const first = extractGitWebhookDeliveryId({
			provider: "gitlab",
			headers: {},
			payloadHash,
			scopeHash,
			eventType: "push",
		});
		const second = extractGitWebhookDeliveryId({
			provider: "gitlab",
			headers: {},
			payloadHash,
			scopeHash,
			eventType: "push",
		});
		expect(first).toBe(second);
		expect(first).toMatch(/^[a-f0-9]{64}$/);
	});
});

describe("Git webhook event parity", () => {
	it("normalizes GitLab merge requests", () => {
		const event = normalizeGitWebhookEvent({
			provider: "gitlab",
			headers: { "x-gitlab-event": "Merge Request Hook" },
			body: {
				user: { id: 7, username: "mayowa" },
				project: { namespace: "vlyv", path: "api" },
				object_attributes: {
					id: 99,
					iid: 12,
					action: "update",
					source_branch: "feature/git-delivery",
					target_branch: "main",
					title: "Add delivery",
					url: "https://gitlab.example/vlyv/api/-/merge_requests/12",
					last_commit: { id: "abc123" },
				},
			},
		});
		expect(event).toMatchObject({
			eventType: "pull_request",
			action: "update",
			branch: "main",
			sourceBranch: "feature/git-delivery",
			commitSha: "abc123",
			pullRequestNumber: 12,
			pullRequestAuthor: "mayowa",
			pullRequestAuthorId: "7",
			closed: false,
		});
	});

	it("normalizes Gitea pull request closure", () => {
		const event = normalizeGitWebhookEvent({
			provider: "gitea",
			headers: { "x-gitea-event": "pull_request" },
			body: {
				action: "closed",
				repository: { name: "api", owner: { login: "vlyv" } },
				pull_request: {
					id: 44,
					number: 4,
					title: "Preview",
					head: { ref: "feature", sha: "def456" },
					base: { ref: "main" },
					user: { id: 8, login: "mayowa" },
				},
			},
		});
		expect(event).toMatchObject({
			eventType: "pull_request",
			pullRequestId: "44",
			pullRequestNumber: 4,
			closed: true,
		});
	});

	it("normalizes Bitbucket pull requests", () => {
		const event = normalizeGitWebhookEvent({
			provider: "bitbucket",
			headers: { "x-event-key": "pullrequest:updated" },
			body: {
				actor: { nickname: "mayowa", uuid: "{user-1}" },
				repository: { workspace: { slug: "vlyv" }, slug: "api" },
				pullrequest: {
					id: 18,
					title: "Delivery",
					source: { branch: { name: "feature" }, commit: { hash: "123" } },
					destination: { branch: { name: "main" } },
					links: {
						html: { href: "https://bitbucket.org/vlyv/api/pull-requests/18" },
					},
				},
			},
		});
		expect(event).toMatchObject({
			eventType: "pull_request",
			action: "updated",
			branch: "main",
			sourceBranch: "feature",
			pullRequestNumber: 18,
			pullRequestAuthorId: "{user-1}",
		});
	});

	it("includes added, modified and removed push paths", () => {
		const event = normalizeGitWebhookEvent({
			provider: "github",
			headers: { "x-github-event": "push" },
			body: {
				ref: "refs/heads/main",
				commits: [
					{
						added: ["src/new.ts"],
						modified: ["src/index.ts"],
						removed: ["src/old.ts"],
					},
				],
			},
		});
		expect(event.changedPaths).toEqual([
			"src/new.ts",
			"src/index.ts",
			"src/old.ts",
		]);
	});
});
