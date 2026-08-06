import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	applicationFindFirst: vi.fn(),
	admitGitDelivery: vi.fn(),
	enqueueGitDeliveryTarget: vi.fn(),
	verifyGitWebhookSignature: vi.fn(),
	normalizeGitWebhookEvent: vi.fn(),
	resolveGitBranchEnvironmentMapping: vi.fn(),
	verifyGitPullRequestAuthor: vi.fn(),
	createPreviewDeployment: vi.fn(),
	findPreviewDeploymentByApplicationId: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field, value) => ({ field, value })),
}));

vi.mock("@/server/db/schema", () => ({
	applications: { refreshToken: "application.refreshToken" },
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			applications: { findFirst: mocks.applicationFindFirst },
		},
	},
}));

vi.mock("@dokploy/server", () => ({
	admitGitDelivery: mocks.admitGitDelivery,
	createPreviewDeployment: mocks.createPreviewDeployment,
	detectGitWebhookProvider: vi.fn(() => "gitlab"),
	extractGitWebhookDeliveryId: vi.fn(() => "gitlab-delivery-1"),
	findPreviewDeploymentByApplicationId:
		mocks.findPreviewDeploymentByApplicationId,
	getBitbucketHeaders: vi.fn(() => ({})),
	gitWebhookPayloadHash: vi.fn(() => "payload-hash"),
	gitWebhookProviderScopeHash: vi.fn(() => "scope-hash"),
	IS_MANAGED_PAAS: true,
	normalizeGitWebhookEvent: mocks.normalizeGitWebhookEvent,
	resolveGitBranchEnvironmentMapping: mocks.resolveGitBranchEnvironmentMapping,
	shouldDeploy: vi.fn(() => true),
	verifyGitPullRequestAuthor: mocks.verifyGitPullRequestAuthor,
	verifyGitWebhookSignature: mocks.verifyGitWebhookSignature,
}));

vi.mock("@/server/git-delivery", () => ({
	enqueueGitDeliveryTarget: mocks.enqueueGitDeliveryTarget,
	readRawJsonWebhook: vi.fn(async (req: NextApiRequest) => ({
		rawBody: Buffer.from(JSON.stringify(req.body)),
		body: req.body,
	})),
}));

import handler from "@/pages/api/deploy/[refreshToken]";

const application = {
	applicationId: "application-1",
	name: "API",
	refreshToken: "secret",
	autoDeploy: true,
	sourceType: "gitlab",
	gitlabId: "gitlab-1",
	gitlabProjectId: 42,
	gitlabOwner: "vlyv",
	gitlabRepository: "api",
	gitlabBranch: "main",
	serverId: null,
	watchPaths: null,
	isPreviewDeploymentsActive: true,
	previewRequireCollaboratorPermissions: true,
	github: null,
	gitlab: { gitProviderId: "git-provider-1" },
	gitea: null,
	bitbucket: null,
	environmentId: "environment-1",
	environment: {
		name: "Production",
		isDefault: true,
		projectId: "project-1",
		project: {
			projectId: "project-1",
			organizationId: "organization-1",
		},
	},
};

const response = () => {
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

const request = (body: Record<string, unknown> = {}) =>
	({
		method: "POST",
		query: { refreshToken: "secret" },
		headers: {
			"x-gitlab-event": "Push Hook",
			"x-gitlab-event-uuid": "gitlab-delivery-1",
			"x-gitlab-token": "secret",
		},
		body,
	}) as unknown as NextApiRequest;

describe("provider-parity Git delivery handler", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.applicationFindFirst.mockResolvedValue(application);
		mocks.verifyGitWebhookSignature.mockReturnValue({
			verified: true,
			algorithm: "shared-token",
		});
		mocks.normalizeGitWebhookEvent.mockReturnValue({
			provider: "gitlab",
			eventType: "push",
			repositoryOwner: "vlyv",
			repositoryName: "api",
			branch: "main",
			commitSha: "abc123",
			commitMessage: "feat: delivery",
			changedPaths: ["src/index.ts"],
			closed: false,
		});
		mocks.resolveGitBranchEnvironmentMapping.mockResolvedValue({
			isProduction: true,
		});
		mocks.admitGitDelivery.mockImplementation(async ({ targets }) => ({
			delivery: { gitDeliveryId: "delivery-row-1" },
			targets: targets.map((target: unknown) => ({
				...(target as object),
				gitDeliveryTargetId: "target-1",
			})),
			duplicate: false,
		}));
		mocks.enqueueGitDeliveryTarget.mockResolvedValue(true);
		mocks.findPreviewDeploymentByApplicationId.mockResolvedValue(null);
		mocks.verifyGitPullRequestAuthor.mockResolvedValue(true);
		mocks.createPreviewDeployment.mockResolvedValue({
			previewDeploymentId: "preview-1",
			pullRequestCommentId: "",
		});
	});

	it("persists and enqueues a signed GitLab production promotion", async () => {
		const res = response();
		await handler(request(), res);

		expect(mocks.admitGitDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "organization-1",
				provider: "gitlab",
				providerDeliveryId: "gitlab-delivery-1",
				metadata: expect.objectContaining({ productionPromotion: true }),
				targets: [
					expect.objectContaining({
						targetKey: "application:application-1",
						job: expect.objectContaining({
							deployment: expect.objectContaining({ sourceBranch: "main" }),
						}),
					}),
				],
			}),
		);
		expect(mocks.enqueueGitDeliveryTarget).toHaveBeenCalledWith("target-1");
		expect(res.status).toHaveBeenCalledWith(202);
	});

	it("rejects an invalid provider token before durable admission", async () => {
		mocks.verifyGitWebhookSignature.mockReturnValue({
			verified: false,
			algorithm: "shared-token",
		});
		const res = response();
		await handler(request(), res);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(mocks.admitGitDelivery).not.toHaveBeenCalled();
	});

	it("authorizes and creates provider-parity pull request previews", async () => {
		mocks.applicationFindFirst.mockResolvedValue({
			...application,
			previewRequireCollaboratorPermissions: false,
		});
		mocks.normalizeGitWebhookEvent.mockReturnValue({
			provider: "gitlab",
			eventType: "pull_request",
			action: "update",
			repositoryOwner: "vlyv",
			repositoryName: "api",
			branch: "main",
			sourceBranch: "feature/git",
			commitSha: "def456",
			commitMessage: "Preview",
			changedPaths: [],
			pullRequestId: "99",
			pullRequestNumber: 12,
			pullRequestTitle: "Preview",
			pullRequestUrl: "https://gitlab.example/vlyv/api/-/merge_requests/12",
			pullRequestAuthor: "mayowa",
			pullRequestAuthorId: "7",
			closed: false,
		});
		const res = response();
		await handler(request(), res);

		expect(mocks.verifyGitPullRequestAuthor).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "gitlab",
				providerProjectId: "42",
				author: "mayowa",
			}),
		);
		expect(mocks.createPreviewDeployment).toHaveBeenCalledWith(
			expect.objectContaining({ branch: "feature/git" }),
		);
		expect(mocks.admitGitDelivery).toHaveBeenCalledWith(
			expect.objectContaining({
				targets: [
					expect.objectContaining({
						previewDeploymentId: "preview-1",
						targetKey: "preview:preview-1",
					}),
				],
			}),
		);
	});
});
