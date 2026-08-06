import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	eq: vi.fn((field: string, value: unknown) => ({ field, value })),
	and: vi.fn((...conditions: Array<{ field: string; value: unknown }>) => ({
		conditions,
	})),
	githubFindFirst: vi.fn(),
	applicationsFindMany: vi.fn(),
	composeFindMany: vi.fn(),
	queueAdd: vi.fn(),
	admitGitDelivery: vi.fn(),
	enqueueGitDeliveryTarget: vi.fn(),
	resolveGitBranchEnvironmentMapping: vi.fn(),
	verifyGitWebhookSignature: vi.fn(),
	normalizeGitWebhookEvent: vi.fn(),
	verify: vi.fn(),
	shouldDeploy: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	eq: mocks.eq,
	and: mocks.and,
}));

vi.mock("@/server/db/schema", () => ({
	applications: {
		sourceType: "application.sourceType",
		autoDeploy: "application.autoDeploy",
		triggerType: "application.triggerType",
		branch: "application.branch",
		repository: "application.repository",
		owner: "application.owner",
		githubId: "application.githubId",
		isPreviewDeploymentsActive: "application.isPreviewDeploymentsActive",
	},
	compose: {
		sourceType: "compose.sourceType",
		autoDeploy: "compose.autoDeploy",
		triggerType: "compose.triggerType",
		branch: "compose.branch",
		repository: "compose.repository",
		owner: "compose.owner",
		githubId: "compose.githubId",
	},
	github: {
		githubInstallationId: "github.githubInstallationId",
	},
	previewDeployments: {
		pullRequestId: "preview.pullRequestId",
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			github: {
				findFirst: mocks.githubFindFirst,
			},
			applications: {
				findMany: mocks.applicationsFindMany,
			},
			compose: {
				findMany: mocks.composeFindMany,
			},
		},
	},
}));

vi.mock("@dokploy/server", () => ({
	admitGitDelivery: mocks.admitGitDelivery,
	IS_CLOUD: false,
	shouldDeploy: mocks.shouldDeploy,
	checkUserRepositoryPermissions: vi.fn(),
	createPreviewDeployment: vi.fn(),
	createSecurityBlockedComment: vi.fn(),
	findGithubById: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
	findPreviewDeploymentsByPullRequestId: vi.fn(),
	getBitbucketHeaders: vi.fn(() => ({})),
	gitWebhookPayloadHash: vi.fn(() => "payload-hash"),
	gitWebhookProviderScopeHash: vi.fn(() => "scope-hash"),
	extractGitWebhookDeliveryId: vi.fn(() => "delivery-1"),
	normalizeGitWebhookEvent: mocks.normalizeGitWebhookEvent,
	removePreviewDeployment: vi.fn(),
	resolveGitBranchEnvironmentMapping: mocks.resolveGitBranchEnvironmentMapping,
	verifyGitWebhookSignature: mocks.verifyGitWebhookSignature,
}));

vi.mock("@octokit/webhooks", () => ({
	Webhooks: vi.fn().mockImplementation(function Webhooks() {
		return {
			verify: mocks.verify,
		};
	}),
}));

vi.mock("@/server/queues/queueSetup", () => ({
	myQueue: {
		add: mocks.queueAdd,
	},
}));

vi.mock("@/server/git-delivery", () => ({
	enqueueGitDeliveryTarget: mocks.enqueueGitDeliveryTarget,
	readRawJsonWebhook: vi.fn(async (req: NextApiRequest) => ({
		rawBody: Buffer.from(JSON.stringify(req.body)),
		body: req.body,
	})),
}));

vi.mock("@/server/utils/deploy", () => ({
	deploy: vi.fn(),
}));

import handler from "@/pages/api/deploy/github";

const getConditionValue = (
	where: { conditions?: Array<{ field: string; value: unknown }> } | undefined,
	field: string,
) => where?.conditions?.find((condition) => condition.field === field)?.value;

const createResponse = () => {
	const res = {
		status: vi.fn(),
		json: vi.fn(),
	} as unknown as NextApiResponse & {
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
	};

	res.status.mockImplementation(() => res);
	res.json.mockImplementation(() => res);

	return res;
};

const createPushRequest = (
	branch: string,
	owner: { login?: string; name?: string } = { login: "agentHits" },
) =>
	({
		headers: {
			"x-hub-signature-256": "sha256=test-signature",
			"x-github-event": "push",
		},
		body: {
			installation: {
				id: 12345,
			},
			ref: `refs/heads/${branch}`,
			after: "abc123",
			head_commit: {
				message: "fix: trigger deployment",
			},
			commits: [
				{
					modified: ["src/index.ts"],
				},
			],
			repository: {
				name: "dokploy",
				full_name: "agentHits/dokploy",
				clone_url: "https://github.com/agentHits/dokploy.git",
				html_url: "https://github.com/agentHits/dokploy",
				owner,
			},
		},
	}) as unknown as NextApiRequest;

const createTagRequest = (tagName: string) => {
	const req = createPushRequest("main") as unknown as {
		body: { ref: string; head_commit: { message: string } };
	};

	req.body.ref = `refs/tags/${tagName}`;
	req.body.head_commit.message = `release: ${tagName}`;

	return req as unknown as NextApiRequest;
};

describe("GitHub app webhook auto-deploy", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.githubFindFirst.mockResolvedValue({
			githubId: "github-provider-id",
			githubInstallationId: 12345,
			githubWebhookSecret: "webhook-secret",
			gitProviderId: "git-provider-id",
			gitProvider: { organizationId: "organization-id" },
		});
		mocks.verify.mockResolvedValue(true);
		mocks.verifyGitWebhookSignature.mockReturnValue({
			verified: true,
			algorithm: "hmac-sha256",
		});
		mocks.normalizeGitWebhookEvent.mockImplementation(({ body }) => ({
			provider: "github",
			eventType: body.ref.startsWith("refs/tags/") ? "tag" : "push",
			repositoryOwner:
				body.repository.owner.name ?? body.repository.owner.login,
			repositoryName: body.repository.name,
			branch: body.ref.replace(/^refs\/(heads|tags)\//, ""),
			commitSha: body.after,
			commitMessage: body.head_commit.message,
			changedPaths: body.commits.flatMap(
				(commit: { modified: string[] }) => commit.modified,
			),
			closed: false,
		}));
		mocks.resolveGitBranchEnvironmentMapping.mockResolvedValue({
			isProduction: true,
		});
		mocks.admitGitDelivery.mockImplementation(async ({ targets }) => ({
			delivery: { gitDeliveryId: "git-delivery-id" },
			targets: targets.map((target: unknown, index: number) => ({
				...(target as object),
				gitDeliveryTargetId: `target-${index + 1}`,
			})),
			duplicate: false,
		}));
		mocks.enqueueGitDeliveryTarget.mockResolvedValue(true);
		mocks.shouldDeploy.mockReturnValue(true);
		mocks.composeFindMany.mockResolvedValue([]);
		mocks.queueAdd.mockResolvedValue({ id: "job-id" });

		mocks.applicationsFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "application.sourceType") === "github" &&
				getConditionValue(where, "application.autoDeploy") === true &&
				getConditionValue(where, "application.triggerType") === "push" &&
				getConditionValue(where, "application.repository") === "dokploy" &&
				getConditionValue(where, "application.owner") === "agentHits" &&
				getConditionValue(where, "application.githubId") ===
					"github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								applicationId: "application-id",
								name: "API",
								sourceType: "github",
								branch: "main",
								autoDeploy: true,
								serverId: null,
								watchPaths: null,
								environment: {
									name: "Production",
									isDefault: true,
									projectId: "project-id",
									project: {
										projectId: "project-id",
										organizationId: "organization-id",
									},
								},
							},
						]
					: [],
			);
		});
	});

	it("matches push events using repository owner name when available", async () => {
		const res = createResponse();

		await handler(
			createPushRequest("main", {
				login: "agentHits-login",
				name: "agentHits",
			}),
			res,
		);

		expect(mocks.admitGitDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				providerDeliveryId: "delivery-1",
				targets: [
					expect.objectContaining({
						applicationId: "application-id",
						targetKey: "application:application-id",
					}),
				],
			}),
		);
		expect(mocks.enqueueGitDeliveryTarget).toHaveBeenCalledWith("target-1");
		expect(res.status).toHaveBeenCalledWith(202);
	});

	it("matches compose push events using repository owner login fallback", async () => {
		mocks.applicationsFindMany.mockResolvedValue([]);
		mocks.composeFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "compose.sourceType") === "github" &&
				getConditionValue(where, "compose.autoDeploy") === true &&
				getConditionValue(where, "compose.triggerType") === "push" &&
				getConditionValue(where, "compose.branch") === "main" &&
				getConditionValue(where, "compose.repository") === "dokploy" &&
				getConditionValue(where, "compose.owner") === "agentHits" &&
				getConditionValue(where, "compose.githubId") === "github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								composeId: "compose-id",
								name: "Compose",
								serverId: null,
								watchPaths: null,
							},
						]
					: [],
			);
		});
		const res = createResponse();

		await handler(createPushRequest("main"), res);

		expect(mocks.admitGitDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				targets: [
					expect.objectContaining({
						composeId: "compose-id",
						targetKey: "compose:compose-id",
					}),
				],
			}),
		);
		expect(res.status).toHaveBeenCalledWith(202);
	});

	it("matches tag events using repository owner login fallback", async () => {
		mocks.applicationsFindMany.mockImplementation(({ where }) => {
			const matches =
				getConditionValue(where, "application.sourceType") === "github" &&
				getConditionValue(where, "application.autoDeploy") === true &&
				getConditionValue(where, "application.triggerType") === "tag" &&
				getConditionValue(where, "application.repository") === "dokploy" &&
				getConditionValue(where, "application.owner") === "agentHits" &&
				getConditionValue(where, "application.githubId") ===
					"github-provider-id";

			return Promise.resolve(
				matches
					? [
							{
								applicationId: "application-id",
								name: "API",
								serverId: null,
								environment: { isDefault: true },
							},
						]
					: [],
			);
		});
		const res = createResponse();

		await handler(createTagRequest("v1.0.0"), res);

		expect(mocks.admitGitDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "tag",
				targets: [expect.objectContaining({ applicationId: "application-id" })],
			}),
		);
		expect(res.status).toHaveBeenCalledWith(202);
	});

	it("does not deploy when the pushed branch does not match", async () => {
		mocks.resolveGitBranchEnvironmentMapping.mockResolvedValue(null);
		const res = createResponse();

		await handler(createPushRequest("feature"), res);

		expect(mocks.admitGitDelivery).toHaveBeenCalledWith(
			expect.objectContaining({ targets: [] }),
		);
		expect(res.status).toHaveBeenCalledWith(202);
	});

	it("rejects an invalid raw-body signature before recording a delivery", async () => {
		mocks.verifyGitWebhookSignature.mockReturnValue({
			verified: false,
			algorithm: "hmac-sha256",
		});
		const res = createResponse();

		await handler(createPushRequest("main"), res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocks.admitGitDelivery).not.toHaveBeenCalled();
	});
});
