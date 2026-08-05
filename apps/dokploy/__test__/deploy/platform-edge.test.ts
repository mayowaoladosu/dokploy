import type {
	PlatformEdgeProvider,
	PlatformEdgePublication,
} from "@dokploy/server/db/schema";
import type { CloudflareEdgeClient } from "@dokploy/server/services/cloudflare-edge";
import type { EdgeRouter } from "@dokploy/server/services/edge-router";
import { createCloudflarePlatformEdgeRouter } from "@dokploy/server/services/platform-edge";
import type { ReleaseApplication } from "@dokploy/server/services/release-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { existingPublications, insertedValues, updatedValues } = vi.hoisted(
	() => ({
		existingPublications: [] as PlatformEdgePublication[],
		insertedValues: [] as any[],
		updatedValues: [] as any[],
	}),
);

vi.mock("@dokploy/server/db", () => {
	const insertChain = {
		values: vi.fn((values: unknown) => {
			insertedValues.push(values);
			return insertChain;
		}),
		onConflictDoUpdate: vi.fn(async () => undefined),
	};
	const updateChain = {
		set: vi.fn((values: unknown) => {
			updatedValues.push(values);
			return updateChain;
		}),
		where: vi.fn(async () => undefined),
	};
	const deleteChain = { where: vi.fn(async () => undefined) };
	return {
		db: {
			query: {
				platformEdgePublications: {
					findMany: vi.fn(async () => existingPublications),
				},
			},
			insert: vi.fn(() => insertChain),
			update: vi.fn(() => updateChain),
			delete: vi.fn(() => deleteChain),
		},
	};
});

const provider = {
	edgeProviderId: "edge-1",
	status: "active",
	originHostname: "origin.vlyv.dev",
} as PlatformEdgeProvider;

const application = (releaseIdentity: string, hosts: string[]) =>
	({
		applicationId: "application-1",
		releaseIdentity,
		releaseDomains: hosts.map((host) => ({ host, https: true, path: "/" })),
	}) as ReleaseApplication;

const originRouter = (): EdgeRouter => ({
	provider: "kubernetes-gateway-api",
	publish: vi.fn(async ({ application: release }) => ({
		provider: "kubernetes-gateway-api",
		domains:
			release.releaseDomains?.map((domain: { host: string }) => domain.host) ??
			[],
		publishedAt: new Date(0).toISOString(),
	})),
	withdraw: vi.fn(async () => undefined),
});

const edgeClient = (): CloudflareEdgeClient =>
	({
		publishHostname: vi.fn(),
		deleteHostname: vi.fn(async () => undefined),
	}) as unknown as CloudflareEdgeClient;

afterEach(() => vi.unstubAllEnvs());

describe("platform Cloudflare edge lifecycle", () => {
	beforeEach(() => {
		existingPublications.length = 0;
		insertedValues.length = 0;
		updatedValues.length = 0;
		vi.clearAllMocks();
		vi.stubEnv("PLATFORM_APPS_DOMAIN", "apps.vlyv.dev");
	});

	it("uses the shared wildcard for platform-managed application hostnames", async () => {
		const client = edgeClient();
		const router = createCloudflarePlatformEdgeRouter({
			originRouter: originRouter(),
			provider,
			client,
		});

		await expect(
			router.publish({
				releaseId: "release-platform",
				deploymentId: "deployment-platform",
				application: application("application-1", ["app.apps.vlyv.dev"]),
			}),
		).resolves.toMatchObject({ domains: ["app.apps.vlyv.dev"] });
		expect(client.publishHostname).not.toHaveBeenCalled();
		expect(insertedValues).toHaveLength(0);
	});

	it("prevents a preview from taking over a production hostname", async () => {
		existingPublications.push({
			edgePublicationId: "publication-production",
			edgeProviderId: "edge-1",
			applicationId: "application-1",
			deploymentId: "deployment-production",
			releaseIdentity: "application-1",
			hostname: "app.vlyv.dev",
			kind: "dns",
			status: "active",
			providerResourceId: "dns-production",
			originHostname: "origin.vlyv.dev",
			lastMeteredAt: new Date(0),
			errorMessage: null,
			metadata: {},
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const client = edgeClient();
		const router = createCloudflarePlatformEdgeRouter({
			originRouter: originRouter(),
			provider,
			client,
		});

		await expect(
			router.publish({
				releaseId: "release-preview",
				deploymentId: "deployment-preview",
				application: application("preview-42", ["app.vlyv.dev"]),
			}),
		).rejects.toThrow("belongs to another release identity");
		expect(client.publishHostname).not.toHaveBeenCalled();
	});

	it("restores an existing publication when a later hostname fails", async () => {
		existingPublications.push({
			edgePublicationId: "publication-a",
			edgeProviderId: "edge-1",
			applicationId: "application-1",
			deploymentId: "deployment-old",
			releaseIdentity: "application-1",
			hostname: "a.vlyv.dev",
			kind: "dns",
			status: "active",
			providerResourceId: "dns-a",
			originHostname: "origin.vlyv.dev",
			lastMeteredAt: new Date(0),
			errorMessage: null,
			metadata: { previous: true },
			createdAt: new Date(0),
			updatedAt: new Date(0),
		});
		const client = edgeClient();
		vi.mocked(client.publishHostname)
			.mockResolvedValueOnce({
				resource: { id: "dns-a" },
				kind: "dns",
				created: false,
			})
			.mockRejectedValueOnce(new Error("Cloudflare failed on b"));
		const router = createCloudflarePlatformEdgeRouter({
			originRouter: originRouter(),
			provider,
			client,
		});

		await expect(
			router.publish({
				releaseId: "release-new",
				deploymentId: "deployment-new",
				application: application("application-1", ["a.vlyv.dev", "b.vlyv.dev"]),
			}),
		).rejects.toThrow("Cloudflare failed on b");
		expect(client.deleteHostname).not.toHaveBeenCalledWith(
			expect.objectContaining({ hostname: "a.vlyv.dev" }),
		);
		expect(updatedValues).toContainEqual(
			expect.objectContaining({
				deploymentId: "deployment-old",
				providerResourceId: "dns-a",
				metadata: { previous: true },
			}),
		);
	});
});
