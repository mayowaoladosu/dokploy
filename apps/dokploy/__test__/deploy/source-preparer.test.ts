import type { ReleaseApplication } from "@dokploy/server/services/release-types";
import { createApplicationSourcePreparer } from "@dokploy/server/services/source-preparer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getBuildCommand: vi.fn(),
	cloneGithubRepository: vi.fn(),
	cloneGitlabRepository: vi.fn(),
	cloneGiteaRepository: vi.fn(),
	cloneBitbucketRepository: vi.fn(),
	cloneGitRepository: vi.fn(),
	buildRemoteDocker: vi.fn(),
	generateApplyPatchesCommand: vi.fn(),
}));

vi.mock("@dokploy/server/utils/builders", () => ({
	getBuildCommand: mocks.getBuildCommand,
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	cloneGithubRepository: mocks.cloneGithubRepository,
}));
vi.mock("@dokploy/server/utils/providers/gitlab", () => ({
	cloneGitlabRepository: mocks.cloneGitlabRepository,
}));
vi.mock("@dokploy/server/utils/providers/gitea", () => ({
	cloneGiteaRepository: mocks.cloneGiteaRepository,
}));
vi.mock("@dokploy/server/utils/providers/bitbucket", () => ({
	cloneBitbucketRepository: mocks.cloneBitbucketRepository,
}));
vi.mock("@dokploy/server/utils/providers/git", () => ({
	cloneGitRepository: mocks.cloneGitRepository,
}));
vi.mock("@dokploy/server/utils/providers/docker", () => ({
	buildRemoteDocker: mocks.buildRemoteDocker,
}));
vi.mock("@dokploy/server/services/patch", () => ({
	generateApplyPatchesCommand: mocks.generateApplyPatchesCommand,
}));

const application = (sourceType: ReleaseApplication["sourceType"]) =>
	({
		applicationId: "application-1",
		appName: "example-app",
		sourceType,
		buildType: "railpack",
		serverId: "runtime-1",
		buildServerId: "builder-1",
		environment: { project: { organizationId: "organization-1" } },
	}) as unknown as ReleaseApplication;

describe("application source preparer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getBuildCommand.mockResolvedValue("build;");
		mocks.cloneGithubRepository.mockResolvedValue("clone-github;");
		mocks.cloneGitlabRepository.mockResolvedValue("clone-gitlab;");
		mocks.cloneGiteaRepository.mockResolvedValue("clone-gitea;");
		mocks.cloneBitbucketRepository.mockResolvedValue("clone-bitbucket;");
		mocks.cloneGitRepository.mockResolvedValue("clone-git;");
		mocks.buildRemoteDocker.mockResolvedValue("pull-image;");
		mocks.generateApplyPatchesCommand.mockResolvedValue("patch;");
	});

	it.each([
		["github", "cloneGithubRepository"],
		["gitlab", "cloneGitlabRepository"],
		["gitea", "cloneGiteaRepository"],
		["bitbucket", "cloneBitbucketRepository"],
		["git", "cloneGitRepository"],
	] as const)(
		"hides %s clone and patch commands",
		async (sourceType, mockName) => {
			const preparer = createApplicationSourcePreparer({
				registryCredentialMode: "environment",
				uploadApplicationRegistries: false,
			});
			const result = await preparer.prepare({
				application: application(sourceType),
				intent: { kind: "deploy" },
				workspace: "fresh",
			});

			expect(mocks[mockName]).toHaveBeenCalledWith(
				expect.objectContaining({
					serverId: "builder-1",
					credentialMode: "environment",
				}),
			);
			expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledWith({
				id: "application-1",
				type: "application",
				serverId: "builder-1",
				appName: "example-app",
			});
			expect(result.command).toContain("patch;build;");
		},
	);

	it("rebuilds without reacquiring or patching source", async () => {
		const preparer = createApplicationSourcePreparer({
			registryCredentialMode: "inline",
			uploadApplicationRegistries: true,
		});
		const result = await preparer.prepare({
			application: application("github"),
			intent: { kind: "rebuild" },
			workspace: "persistent",
		});

		expect(mocks.cloneGithubRepository).not.toHaveBeenCalled();
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(result.command).toBe("set -e;build;");
	});

	it("pulls Docker sources and passes platform registry policy to the builder", async () => {
		const preparer = createApplicationSourcePreparer({
			registryCredentialMode: "environment",
			uploadApplicationRegistries: false,
		});
		await preparer.prepare({
			application: application("docker"),
			intent: { kind: "deploy" },
			workspace: "fresh",
		});

		expect(mocks.buildRemoteDocker).toHaveBeenCalledWith(
			expect.objectContaining({ sourceType: "docker" }),
			"environment",
		);
		expect(mocks.generateApplyPatchesCommand).not.toHaveBeenCalled();
		expect(mocks.getBuildCommand).toHaveBeenCalledWith(
			expect.objectContaining({ sourceType: "docker" }),
			{
				registryCredentialMode: "environment",
				uploadApplicationRegistries: false,
			},
		);
	});

	it("applies preview patches from the owning application into the preview workspace", async () => {
		const preview = {
			...application("github"),
			appName: "preview-pr-42",
			releaseIdentity: "preview-42",
		};
		const preparer = createApplicationSourcePreparer({
			registryCredentialMode: "environment",
			uploadApplicationRegistries: false,
		});
		await preparer.prepare({
			application: preview,
			intent: {
				kind: "preview-deploy",
				sourceApplicationId: "application-1",
			},
			workspace: "fresh",
		});

		expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "application-1",
				appName: "preview-pr-42",
			}),
		);
	});

	it("reacquires source when an ephemeral executor rebuilds", async () => {
		const preparer = createApplicationSourcePreparer({
			registryCredentialMode: "environment",
			uploadApplicationRegistries: false,
		});
		await preparer.prepare({
			application: application("github"),
			intent: { kind: "rebuild" },
			workspace: "fresh",
		});

		expect(mocks.cloneGithubRepository).toHaveBeenCalledTimes(1);
		expect(mocks.generateApplyPatchesCommand).toHaveBeenCalledTimes(1);
	});
});
