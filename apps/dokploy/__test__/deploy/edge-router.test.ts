import type {
	PlatformClusterMetadata,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { createKubernetesEdgeRouter } from "@dokploy/server/services/edge-router";
import type { KubernetesControlPlane } from "@dokploy/server/services/kubernetes/client";
import { kubernetesReleaseNamespace } from "@dokploy/server/services/kubernetes/manifests";
import type { ReleaseApplication } from "@dokploy/server/services/release-types";
import { describe, expect, it, vi } from "vitest";

const client = (): KubernetesControlPlane => ({
	apply: vi.fn(async () => undefined),
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
});
