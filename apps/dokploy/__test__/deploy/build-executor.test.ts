import { createShellBuildExecutor } from "@dokploy/server/services/build-executor";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	execAsyncMock,
	execAsyncRemoteMock,
	getImageNameMock,
	getRemoteDockerMock,
	inspectImageMock,
} = vi.hoisted(() => ({
	execAsyncMock: vi.fn(),
	execAsyncRemoteMock: vi.fn(),
	getImageNameMock: vi.fn(),
	getRemoteDockerMock: vi.fn(),
	inspectImageMock: vi.fn(),
}));

vi.mock("@dokploy/server/utils/builders", () => ({
	getImageName: getImageNameMock,
}));

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: execAsyncMock,
	execAsyncRemote: execAsyncRemoteMock,
}));

vi.mock("@dokploy/server/utils/servers/remote-docker", () => ({
	getRemoteDocker: getRemoteDockerMock,
}));

const application = {
	appName: "test-app",
	applicationId: "application-1",
	buildType: "railpack",
	sourceType: "git",
	buildServerId: null,
	serverId: null,
} as unknown as ApplicationNested;

describe("shell build executor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		execAsyncMock.mockResolvedValue({ stdout: "", stderr: "" });
		getImageNameMock.mockResolvedValue("test-app:latest");
		inspectImageMock.mockResolvedValue({
			Id: "sha256:image-id",
			RepoDigests: [],
			Size: 2_048,
		});
		getRemoteDockerMock.mockResolvedValue({
			getImage: vi.fn(() => ({ inspect: inspectImageMock })),
		});
	});

	it("redirects the assembled build command to the deployment log", async () => {
		const executor = createShellBuildExecutor();

		const result = await executor.execute({
			application,
			deploymentId: "deployment-1",
			command: "set -e; echo build",
			logPath: "/tmp/test deployment.log",
			buildServerId: null,
		});

		expect(execAsyncMock).toHaveBeenCalledWith(
			"(set -e; echo build) >> '/tmp/test deployment.log' 2>&1",
		);
		expect(execAsyncRemoteMock).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			imageId: "sha256:image-id",
			imageRef: "sha256:image-id",
			imageDigest: "sha256:image-id",
			imageSizeBytes: 2_048,
			builder: "railpack",
			executor: "shell",
		});
	});
});
