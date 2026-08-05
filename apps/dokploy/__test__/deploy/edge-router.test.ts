import type {
	PlatformClusterMetadata,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { createKubernetesEdgeRouter } from "@dokploy/server/services/edge-router";
import type { KubernetesControlPlane } from "@dokploy/server/services/kubernetes/client";
import { kubernetesReleaseNamespace } from "@dokploy/server/services/kubernetes/manifests";
import type { ReleaseApplication } from "@dokploy/server/services/release-types";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

const client = (): KubernetesControlPlane => ({
	apply: vi.fn(async () => undefined),
	read: vi.fn(async (resource) => {
		if (resource.kind === "HTTPRoute") {
			return {
				status: {
					parents: [{ conditions: [{ type: "Accepted", status: "True" }] }],
				},
			} as never;
		}
		return {
			status: {
				conditions: [
					{
						type: resource.kind === "Gateway" ? "Programmed" : "Ready",
						status: "True",
					},
				],
			},
		} as never;
	}),
	delete: vi.fn(async () => undefined),
	readDeployment: vi.fn(async () => null),
	readJob: vi.fn(async () => null),
	listPods: vi.fn(async () => []),
	readPodLogs: vi.fn(async () => ""),
	setDeploymentReplicas: vi.fn(async () => undefined),
	restartDeployment: vi.fn(async () => undefined),
	deleteNamespace: vi.fn(async () => undefined),
});

const placement = {
	placementId: "placement-1",
	namespace: "vlyv-app-namespace",
} as PlatformPlacement;
const metadata: PlatformClusterMetadata = {
	gatewayNamespace: "gateway-system",
	gatewayName: "public",
	gatewayClassName: "cilium",
	certIssuerName: "letsencrypt-production",
	gatewayMode: "dedicated",
	externalDnsEnabled: true,
};
const application = {
	applicationId: "application-1",
	releaseIdentity: "preview-42",
	appName: "preview-pr-42",
	ports: [{ targetPort: 3000 }],
	releaseDomains: [{ host: "preview.apps.vlyv.dev", https: true, path: "/" }],
	environment: { project: { organizationId: "organization-1" } },
} as unknown as ReleaseApplication;

describe("Kubernetes edge router", () => {
	it("publishes release-identity Gateway API routes", async () => {
		const controlPlane = client();
		const router = createKubernetesEdgeRouter({
			client: controlPlane,
			placement,
			clusterMetadata: metadata,
		});

		const publication = await router.publish({
			releaseId: "release-1",
			deploymentId: "deployment-1",
			application,
		});

		expect(publication.domains).toEqual(["preview.apps.vlyv.dev"]);
		expect(controlPlane.apply).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({ kind: "HTTPRoute" }),
				expect.objectContaining({ kind: "Certificate" }),
			]),
		);
		const manifests = vi.mocked(controlPlane.apply).mock.calls[0]?.[0] ?? [];
		expect(JSON.stringify(manifests)).toContain("app-preview-42");
		expect(JSON.stringify(manifests)).not.toContain("app-application-1");
		const route = manifests.find((manifest) => manifest.kind === "HTTPRoute");
		expect(route?.metadata?.namespace).toBe(
			kubernetesReleaseNamespace({
				applicationId: "application-1",
				releaseIdentity: "preview-42",
				placementNamespace: "vlyv-app-namespace",
			}),
		);
		expect(route?.metadata?.annotations).toMatchObject({
			"external-dns.alpha.kubernetes.io/hostname": "preview.apps.vlyv.dev",
		});
	});

	it("fails publication when the Gateway controller rejects the route", async () => {
		const controlPlane = client();
		vi.mocked(controlPlane.read).mockImplementation(async (resource) => {
			if (resource.kind === "HTTPRoute") {
				return {
					status: {
						parents: [
							{
								conditions: [
									{
										type: "Accepted",
										status: "False",
										message: "listener denied the route",
									},
								],
							},
						],
					},
				} as never;
			}
			return {
				status: {
					conditions: [
						{
							type: resource.kind === "Gateway" ? "Programmed" : "Ready",
							status: "True",
						},
					],
				},
			} as never;
		});
		const router = createKubernetesEdgeRouter({
			client: controlPlane,
			placement,
			clusterMetadata: metadata,
			routeTimeoutMs: 10,
			pollIntervalMs: 1,
			sleep: async () => undefined,
		});

		await expect(
			router.publish({
				releaseId: "release-1",
				deploymentId: "deployment-1",
				application,
			}),
		).rejects.toThrow("listener denied the route");
	});

	it("withdraws release routes without deleting runtime resources", async () => {
		const controlPlane = client();
		const router = createKubernetesEdgeRouter({
			client: controlPlane,
			placement,
			clusterMetadata: metadata,
		});

		await router.withdraw({ application });

		expect(controlPlane.delete).toHaveBeenCalledTimes(3);
		expect(controlPlane.deleteNamespace).not.toHaveBeenCalled();
	});

	it("shares platform wildcard routing and dedicates custom-domain TLS", async () => {
		vi.stubEnv("PLATFORM_APPS_DOMAIN", "apps.vlyv.dev");
		const platformControlPlane = client();
		const hybridMetadata = { ...metadata, gatewayMode: "hybrid" as const };
		const platformRouter = createKubernetesEdgeRouter({
			client: platformControlPlane,
			placement,
			clusterMetadata: hybridMetadata,
		});
		await platformRouter.publish({
			releaseId: "release-platform",
			deploymentId: "deployment-platform",
			application,
		});
		const platformManifests =
			vi.mocked(platformControlPlane.apply).mock.calls[0]?.[0] ?? [];
		expect(platformManifests.map((manifest) => manifest.kind)).toEqual([
			"HTTPRoute",
		]);

		const customControlPlane = client();
		const customRouter = createKubernetesEdgeRouter({
			client: customControlPlane,
			placement,
			clusterMetadata: hybridMetadata,
		});
		await customRouter.publish({
			releaseId: "release-custom",
			deploymentId: "deployment-custom",
			application: {
				...application,
				releaseDomains: [{ host: "customer.example", https: true, path: "/" }],
			},
		});
		const customKinds = (
			vi.mocked(customControlPlane.apply).mock.calls[0]?.[0] ?? []
		).map((manifest) => manifest.kind);
		expect(customKinds).toEqual(["Certificate", "Gateway", "HTTPRoute"]);
	});
});
