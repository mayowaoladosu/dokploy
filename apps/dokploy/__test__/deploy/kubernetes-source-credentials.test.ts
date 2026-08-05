import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findBitbucketByIdMock, findSSHKeyByIdMock, updateSSHKeyByIdMock } =
	vi.hoisted(() => ({
		findBitbucketByIdMock: vi.fn(),
		findSSHKeyByIdMock: vi.fn(),
		updateSSHKeyByIdMock: vi.fn(),
	}));

vi.mock("@dokploy/server/services/bitbucket", () => ({
	findBitbucketById: findBitbucketByIdMock,
}));

vi.mock("@dokploy/server/services/ssh-key", () => ({
	findSSHKeyById: findSSHKeyByIdMock,
	updateSSHKeyById: updateSSHKeyByIdMock,
}));

describe("Kubernetes source credential commands", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findBitbucketByIdMock.mockResolvedValue({
			apiToken: "bitbucket-super-secret",
			bitbucketUsername: "robot",
			appPassword: null,
		});
		findSSHKeyByIdMock.mockResolvedValue({
			privateKey:
				"-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----",
		});
		updateSSHKeyByIdMock.mockResolvedValue(undefined);
	});

	it("references Bitbucket Secret variables instead of embedding tokens", async () => {
		const command = await cloneBitbucketRepository({
			appName: "example-app",
			bitbucketRepository: "repo",
			bitbucketRepositorySlug: "repo",
			bitbucketOwner: "owner",
			bitbucketBranch: "main",
			bitbucketId: "bitbucket-1",
			enableSubmodules: false,
			serverId: null,
			credentialMode: "environment",
		});

		expect(command).toContain("$VLYV_BITBUCKET_BITBUCKET_1_PASSWORD");
		expect(command).not.toContain("bitbucket-super-secret");
	});

	it("references a Secret variable instead of embedding SSH private keys", async () => {
		const command = await cloneGitRepository({
			appName: "example-app",
			customGitUrl: "git@example.com:owner/repo.git",
			customGitBranch: "main",
			customGitSSHKeyId: "ssh-key-1",
			enableSubmodules: false,
			serverId: null,
			credentialMode: "environment",
		});

		expect(command).toContain("$VLYV_CUSTOM_GIT_SSH_KEY_1_PRIVATE_KEY");
		expect(command).not.toContain("secret-key");
	});
});
