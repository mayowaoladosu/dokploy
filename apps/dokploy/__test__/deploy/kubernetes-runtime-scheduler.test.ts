import type {
	PlatformNodePool,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import type { KubernetesControlPlane } from "@dokploy/server/services/kubernetes/client";
import { kubernetesReleaseNamespace } from "@dokploy/server/services/kubernetes/manifests";
import { createKubernetesRuntimeScheduler } from "@dokploy/server/services/kubernetes/runtime-scheduler";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { describe, expect, it, vi } from "vitest";

describe("Kubernetes runtime scheduler", () => {
	it("applies an immutable release and waits for ready replicas", async () => {
		const appliedManifests: Array<{ kind?: string }> = [];
		const apply = vi.fn<KubernetesControlPlane["apply"]>(async (manifests) => {
			appliedManifests.push(...manifests);
		});
		const client: KubernetesControlPlane = {
			apply,
			delete: vi.fn(async () => undefined),
			readDeployment: vi.fn(
				async () =>
					({
						spec: {
							replicas: 1,
							template: {
								spec: {
									containers: [
										{
											image: "registry.example.com/app@sha256:release",
										},
									],
								},
							},
						},
						status: { readyReplicas: 1 },
					}) as never,
			),
			readJob: vi.fn(async () => null),
			listPods: vi.fn(async () => []),
			readPodLogs: vi.fn(async () => ""),
			setDeploymentReplicas: vi.fn(async () => undefined),
			restartDeployment: vi.fn(async () => undefined),
			deleteNamespace: vi.fn(async () => undefined),
		};
		const placement = {
			placementId: "placement-1",
			applicationId: "application-1",
			organizationId: "organization-1",
			clusterId: "cluster-1",
			namespace: "vlyv-app-abc",
			runtime: "kubernetes",
			status: "pending",
			desiredReplicas: 1,
		} as unknown as PlatformPlacement;
		const nodePool = {
			labels: { "vlyv.dev/pool": "runtime" },
			taints: [],
			runtimeClassName: "gvisor",
		} as unknown as PlatformNodePool;
		const application = {
			applicationId: "application-1",
			appName: "example-app",
			replicas: 1,
			env: "NODE_ENV=production",
			memoryLimit: "536870912",
			memoryReservation: "134217728",
			cpuLimit: "1000000000",
			cpuReservation: "250000000",
			command: null,
			args: [],
			ports: [{ targetPort: 3000, protocol: "tcp" }],
			environmentId: "environment-1",
			environment: {
				env: "",
				project: {
					projectId: "project-1",
					organizationId: "organization-1",
					env: "",
				},
			},
		} as unknown as ApplicationNested;
		const scheduler = createKubernetesRuntimeScheduler({
			client,
			placement,
			clusterMetadata: {},
			nodePool,
			pollIntervalMs: 1,
			sleep: async () => undefined,
		});

		const status = await scheduler.schedule({
			application,
			artifact: {
				imageRef: "registry.example.com/app@sha256:release",
			},
		});

		expect(status).toMatchObject({
			provider: "kubernetes",
			state: "ready",
			readyReplicas: 1,
		});
		expect(apply).toHaveBeenCalledTimes(1);
		const deployment = appliedManifests.find(
			(manifest) => manifest.kind === "Deployment",
		) as any;
		expect(deployment.spec.template.spec.containers[0].image).toBe(
			"registry.example.com/app@sha256:release",
		);
		expect(
			appliedManifests.some((manifest) => manifest.kind === "HTTPRoute"),
		).toBe(false);

		const previewApplication = {
			...application,
			appName: "preview-example-app",
			releaseIdentity: "preview-42",
		};
		await scheduler.schedule({
			application: previewApplication,
			artifact: {
				imageRef: "registry.example.com/app@sha256:preview",
			},
		});
		const previewNamespace = kubernetesReleaseNamespace({
			applicationId: "application-1",
			releaseIdentity: "preview-42",
			placementNamespace: "vlyv-app-abc",
		});
		const previewManifests = vi.mocked(apply).mock.calls[1]?.[0] ?? [];
		expect(
			previewManifests.find((manifest) => manifest.kind === "Namespace")
				?.metadata?.name,
		).toBe(previewNamespace);
		expect(previewNamespace).not.toBe(placement.namespace);

		await scheduler.remove({ application: previewApplication });
		expect(client.deleteNamespace).toHaveBeenCalledWith(previewNamespace);
		expect(client.delete).not.toHaveBeenCalled();
	});
});
