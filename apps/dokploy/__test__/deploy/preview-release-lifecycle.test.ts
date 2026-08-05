import {
	buildPreviewAppName,
	removePreviewDeployment,
} from "@dokploy/server/services/preview-deployment";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findApplicationById: vi.fn(),
	createPlatformReleasePlan: vi.fn(),
	removeDeployments: vi.fn(),
	removeDirectory: vi.fn(),
	deletePreview: vi.fn(),
}));

vi.mock("@dokploy/server/db", () => {
	const deleteChain = {
		where: vi.fn(() => ({ returning: mocks.deletePreview })),
	};
	return {
		db: {
			query: {
				previewDeployments: {
					findFirst: vi.fn(async () => ({
						previewDeploymentId: "preview-42",
						applicationId: "application-1",
						appName: "preview-app-42",
						domain: {
							host: "preview.apps.vlyv.dev",
							https: true,
							path: "/",
						},
					})),
				},
			},
			delete: vi.fn(() => deleteChain),
		},
	};
});

vi.mock("@dokploy/server/services/application", () => ({
	findApplicationById: mocks.findApplicationById,
}));
vi.mock("@dokploy/server/services/platform-release-orchestrator", () => ({
	createPlatformReleasePlan: mocks.createPlatformReleasePlan,
}));
vi.mock("@dokploy/server/services/deployment", () => ({
	removeDeploymentsByPreviewDeploymentId: mocks.removeDeployments,
}));
vi.mock("@dokploy/server/utils/filesystem/directory", () => ({
	removeDirectoryCode: mocks.removeDirectory,
}));
vi.mock("@dokploy/server/utils/providers/github", () => ({
	authGithub: vi.fn(),
}));
vi.mock("@dokploy/server/utils/traefik/domain", () => ({
	manageDomain: vi.fn(),
}));
vi.mock("@dokploy/server/services/domain", () => ({
	createDomain: vi.fn(),
}));
vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(),
	getIssueComment: vi.fn(),
}));
vi.mock("@dokploy/server/services/platform", () => ({
	getManagedApplicationDomain: vi.fn(),
}));
vi.mock("@dokploy/server/services/platform-infrastructure", () => ({
	findApplicationPlatformPlacement: vi.fn(),
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: vi.fn(),
}));

describe("preview release lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.findApplicationById.mockResolvedValue({
			applicationId: "application-1",
			appName: "production-app",
			serverId: null,
			buildServerId: null,
		});
		mocks.removeDeployments.mockResolvedValue(undefined);
		mocks.removeDirectory.mockResolvedValue(undefined);
		mocks.deletePreview.mockResolvedValue([]);
	});

	it("builds stable DNS-safe preview identities within 63 characters", () => {
		const name = buildPreviewAppName(
			"An_App.With-A-Very-Long-Customer-Controlled-Application-Name-123456789",
			"ABC123",
		);

		expect(name.length).toBeLessThanOrEqual(63);
		expect(name).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
		expect(buildPreviewAppName("app", "ABC123")).toBe("preview-app-abc123");
	});

	it("keeps durable state when runtime cleanup fails", async () => {
		const remove = vi.fn(async () => {
			throw new Error("Kubernetes unavailable");
		});
		mocks.createPlatformReleasePlan.mockResolvedValue({
			orchestrator: { remove },
		});

		await expect(removePreviewDeployment("preview-42")).rejects.toThrow(
			"Kubernetes unavailable",
		);
		expect(mocks.deletePreview).not.toHaveBeenCalled();
		expect(mocks.removeDeployments).not.toHaveBeenCalled();
	});

	it("removes the isolated release before deleting durable state", async () => {
		const remove = vi.fn(async () => undefined);
		mocks.createPlatformReleasePlan.mockResolvedValue({
			orchestrator: { remove },
		});

		await removePreviewDeployment("preview-42");

		expect(remove).toHaveBeenCalledWith({
			application: expect.objectContaining({
				applicationId: "application-1",
				appName: "preview-app-42",
				releaseIdentity: "preview-42",
			}),
		});
		expect(mocks.removeDeployments).toHaveBeenCalledTimes(1);
		expect(mocks.deletePreview).toHaveBeenCalledTimes(1);
	});
});
