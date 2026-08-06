import type {
	PlatformNodePool,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import type { KubernetesControlPlane } from "@dokploy/server/services/kubernetes/client";
import { kubernetesReleaseNamespace } from "@dokploy/server/services/kubernetes/manifests";
import {
	classifyKubernetesRuntimeDeployment,
	createKubernetesRuntimeScheduler,
	managedDataEnvironmentForRuntimeApplication,
} from "@dokploy/server/services/kubernetes/runtime-scheduler";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { describe, expect, it, vi } from "vitest";

describe("Kubernetes runtime scheduler", () => {
	it("never injects production data bindings into preview releases", async () => {
		await expect(
			managedDataEnvironmentForRuntimeApplication({
				applicationId: "application-1",
				releaseIdentity: "preview-1",
			}),
		).resolves.toEqual([]);
	});

	it("does not accept stale ready replicas from the previous image", () => {
		expect(
			classifyKubernetesRuntimeDeployment(
				{
					metadata: { generation: 2 },
					spec: {
						replicas: 1,
						template: {
							spec: { containers: [{ image: "registry/app@sha256:old" }] },
						},
					},
					status: {
						observedGeneration: 1,
						updatedReplicas: 1,
						readyReplicas: 1,
						availableReplicas: 1,
					},
				} as never,
				"registry/app@sha256:new",
			),
		).toBe("pending");
	});

	it("applies an immutable release and waits for ready replicas", async () => {
		const releaseImage = `registry.example.com/app@sha256:${"a".repeat(64)}`;
		const previewImage = `registry.example.com/app@sha256:${"b".repeat(64)}`;
		const artifact = (imageRef: string) => ({
			imageId: `sha256:${"c".repeat(64)}`,
			imageDigest: imageRef.split("@")[1] || null,
			imageRef,
			imageSizeBytes: 4_096,
			builder: "railpack",
			executor: "kubernetes-job",
			durationMs: 1_000,
			metadata: {
				supplyChain: {
					sbomDigest: `sha256:${"d".repeat(64)}`,
					vulnerabilityReportDigest: `sha256:${"e".repeat(64)}`,
					signed: true,
					signatureVerified: true,
				},
			},
		});
		const appliedManifests: Array<{ kind?: string }> = [];
		let currentImage = releaseImage;
		const apply = vi.fn<KubernetesControlPlane["apply"]>(async (manifests) => {
			appliedManifests.push(...manifests);
			const deployment = manifests.find(
				(manifest) => manifest.kind === "Deployment",
			) as any;
			if (deployment)
				currentImage = deployment.spec.template.spec.containers[0].image;
		});
		const client: KubernetesControlPlane = {
			apply,
			read: vi.fn(async () => null),
			delete: vi.fn(async () => undefined),
			readDeployment: vi.fn(
				async () =>
					({
						metadata: { generation: 1 },
						spec: {
							replicas: 1,
							template: {
								spec: {
									containers: [
										{
											image: currentImage,
										},
									],
								},
							},
						},
						status: {
							observedGeneration: 1,
							updatedReplicas: 1,
							readyReplicas: 1,
							availableReplicas: 1,
						},
					}) as never,
			),
			readJob: vi.fn(async () => null),
			listPods: vi.fn(async () => []),
			listPodMetrics: vi.fn(async () => []),
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
			healthCheckSwarm: {
				Test: ["CMD-SHELL", "curl -f http://localhost:3000/ready"],
				Interval: 5_000_000_000,
				Timeout: 2_000_000_000,
				StartPeriod: 60_000_000_000,
				Retries: 4,
			},
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
			buildPool: {
				registryAuthMode: "basic",
				registryHost: "registry.example.com",
				registryUsername: "robot",
				registryPassword: "secret",
				runtimeRegistrySecretName: "runtime-registry",
			} as never,
			pollIntervalMs: 1,
			sleep: async () => undefined,
		});

		const status = await scheduler.schedule({
			application,
			artifact: artifact(releaseImage),
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
			releaseImage,
		);
		expect(
			deployment.spec.template.spec.containers[0].readinessProbe.httpGet,
		).toMatchObject({ path: "/ready", port: 3000 });
		expect(
			deployment.spec.template.spec.containers[0].securityContext
				.readOnlyRootFilesystem,
		).toBe(false);
		expect(deployment.spec.template.spec.imagePullSecrets).toEqual([
			{ name: "runtime-registry" },
		]);
		expect(
			appliedManifests.some(
				(manifest: any) =>
					manifest.kind === "Secret" &&
					manifest.metadata?.name === "runtime-registry",
			),
		).toBe(true);
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
			artifact: artifact(previewImage),
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

		await expect(
			scheduler.schedule({
				application,
				artifact: {
					...artifact(releaseImage),
					metadata: {},
				},
			}),
		).rejects.toThrow("signed and verified");
	});
});
