import {
	createKubernetesControlPlane,
	type KubernetesControlPlane,
} from "@dokploy/server/services/kubernetes/client";
import {
	assertBuildPoolReadiness,
	assertKubernetesClusterReadiness,
	buildApplicationNamespace,
	selectKubernetesPlacementCandidate,
	verifyKubernetesClusterCapabilities,
} from "@dokploy/server/services/platform-infrastructure";
import { classifyKubernetesDeployment } from "@dokploy/server/services/platform-reconciler";
import { describe, expect, it, vi } from "vitest";

describe("platform infrastructure placement", () => {
	const candidates = [
		{
			runtimeTargetId: "target-b",
			runtimeTargetName: "runtime-b",
			buildPoolId: "build-b",
			buildPoolName: "build-b",
			clusterId: "cluster-b",
			clusterSlug: "b",
			regionId: "region-east",
			regionSlug: "us-east",
			nodePoolId: "pool-b",
			nodePoolName: "runtime-b",
			placementCount: 8,
			maxPlacements: 10,
			buildPlacementCount: 3,
			maxConcurrentBuilds: 10,
			weight: 100,
		},
		{
			runtimeTargetId: "target-a",
			runtimeTargetName: "runtime-a",
			buildPoolId: "build-a",
			buildPoolName: "build-a",
			clusterId: "cluster-a",
			clusterSlug: "a",
			regionId: "region-west",
			regionSlug: "us-west",
			nodePoolId: "pool-a",
			nodePoolName: "runtime-a",
			placementCount: 2,
			maxPlacements: 10,
			buildPlacementCount: 1,
			maxConcurrentBuilds: 10,
			weight: 100,
		},
	];

	it("selects the least-loaded runtime pool", () => {
		expect(selectKubernetesPlacementCandidate(candidates)?.clusterId).toBe(
			"cluster-a",
		);
	});

	it("honors a requested region before load scoring", () => {
		expect(
			selectKubernetesPlacementCandidate(candidates, "region-east")?.clusterId,
		).toBe("cluster-b");
	});

	it("creates stable opaque per-application namespaces", () => {
		const first = buildApplicationNamespace("organization-1", "application-1");
		const repeated = buildApplicationNamespace(
			"organization-1",
			"application-1",
		);
		const second = buildApplicationNamespace("organization-1", "application-2");

		expect(first).toBe(repeated);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^vlyv-app-[a-f0-9]{20}$/);
		expect(first).not.toContain("organization-1");
	});
});

describe("Kubernetes cluster readiness", () => {
	it("redacts malformed kubeconfig content from errors", () => {
		expect(() =>
			createKubernetesControlPlane({
				kubeconfig: "super-secret-token: [",
			}),
		).toThrow("credentials are invalid or unavailable");
	});

	it("rejects active clusters missing security capabilities", () => {
		expect(() =>
			assertKubernetesClusterReadiness({
				runtime: "kubernetes",
				status: "active",
				kubeconfig: "apiVersion: v1",
				metadata: {},
			}),
		).toThrow("cannot become active");
	});

	it("accepts an active cluster with an immutable sandboxed stack", () => {
		expect(() =>
			assertKubernetesClusterReadiness({
				runtime: "kubernetes",
				status: "active",
				kubeconfig: "apiVersion: v1",
				metadata: {
					builderImage: `registry.example.com/builder@sha256:${"a".repeat(64)}`,
					buildRuntimeClassName: "gvisor",
					runtimeClassName: "gvisor",
					secretsEncryptionEnabled: true,
					networkPolicyEnabled: true,
					metricsServerEnabled: true,
					gatewayApiEnabled: true,
					gatewayNamespace: "gateway-system",
					gatewayName: "public",
					gatewayClassName: "cilium",
					certManagerEnabled: true,
					certIssuerName: "letsencrypt-production",
					externalDnsEnabled: true,
				},
			}),
		).not.toThrow();
	});

	it("rejects active build pools without immutable builders and registry isolation", () => {
		expect(() =>
			assertBuildPoolReadiness({
				runtime: "kubernetes",
				status: "active",
				builderImage: "registry.example.com/builder:latest",
				runtimeClassName: null,
				registryHost: null,
				registryRepositoryPrefix: null,
				registryAuthMode: "basic",
				registryUsername: null,
				registryPassword: null,
				runtimeRegistrySecretName: null,
				metadata: {},
			}),
		).toThrow("build pool cannot become active");
	});

	it("rejects a build pool without a trusted supply-chain gate", () => {
		expect(() =>
			assertBuildPoolReadiness({
				runtime: "kubernetes",
				status: "active",
				builderImage: `registry.example.com/builder@sha256:${"b".repeat(64)}`,
				runtimeClassName: "gvisor",
				registryHost: "registry.example.com",
				registryRepositoryPrefix: "vlyv/apps",
				registryAuthMode: "workload_identity",
				registryUsername: null,
				registryPassword: null,
				runtimeRegistrySecretName: null,
				metadata: {
					registryCredentialHelperConfigured: true,
					runtimeImagePullIdentityConfigured: true,
					rootlessBuilderValidated: true,
				},
			}),
		).toThrow("supplyChain policy");
	});

	it("accepts an isolated, scanned, signed build pool", () => {
		expect(() =>
			assertBuildPoolReadiness({
				runtime: "kubernetes",
				status: "active",
				builderImage: `registry.example.com/builder@sha256:${"b".repeat(64)}`,
				runtimeClassName: "gvisor",
				registryHost: "registry.example.com",
				registryRepositoryPrefix: "vlyv/apps",
				registryAuthMode: "workload_identity",
				registryUsername: null,
				registryPassword: null,
				runtimeRegistrySecretName: null,
				metadata: {
					registryCredentialHelperConfigured: true,
					runtimeImagePullIdentityConfigured: true,
					rootlessBuilderValidated: true,
					supplyChain: {
						verifierImage: `registry.example.com/verifier@sha256:${"c".repeat(64)}`,
						signingKeyRef: "awskms:///alias/vlyv-image-signing",
						maxCriticalVulnerabilities: 0,
						maxHighVulnerabilities: 0,
						ignoreUnfixed: false,
						artifactStorageClassName: "encrypted-ephemeral",
					},
				},
				nodePool: {
					runtimeClassName: "gvisor",
					labels: { "vlyv.dev/pool": "build" },
				} as never,
			}),
		).not.toThrow();
	});

	it("probes required controllers and RuntimeClasses before activation", async () => {
		const controlPlane = {
			read: vi.fn(async (resource: { kind?: string }) => ({
				metadata: { name: "present" },
				status:
					resource.kind === "Deployment"
						? { availableReplicas: 1 }
						: {
								conditions: [
									{
										type:
											resource.kind === "Gateway"
												? "Programmed"
												: resource.kind === "GatewayClass"
													? "Accepted"
													: "Ready",
										status: "True",
									},
								],
							},
			})),
		} as unknown as KubernetesControlPlane;

		await expect(
			verifyKubernetesClusterCapabilities({
				client: controlPlane,
				metadata: {
					gatewayMode: "shared",
					gatewayNamespace: "gateway-system",
					gatewayName: "public",
					gatewayClassName: "cilium",
					certIssuerName: "letsencrypt-production",
					externalDnsEnabled: true,
				},
				runtimeClassNames: ["gvisor"],
			}),
		).resolves.toBeUndefined();
		expect(controlPlane.read).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "RuntimeClass" }),
		);
	});

	it("rejects an operator attestation when a controller is absent", async () => {
		const controlPlane = {
			read: vi.fn(async (resource: { kind?: string }) =>
				resource.kind === "Deployment" ? null : ({ metadata: {} } as never),
			),
		} as unknown as KubernetesControlPlane;

		await expect(
			verifyKubernetesClusterCapabilities({
				client: controlPlane,
				metadata: {
					gatewayMode: "dedicated",
					gatewayNamespace: "gateway-system",
					gatewayName: "public",
					gatewayClassName: "cilium",
					certIssuerName: "letsencrypt-production",
					externalDnsEnabled: true,
				},
			}),
		).rejects.toThrow("capabilities are unavailable");
	});
});

describe("Kubernetes placement reconciliation", () => {
	it("classifies ready, pending, failed, and missing deployments", () => {
		expect(classifyKubernetesDeployment(null)).toBe("missing");
		expect(
			classifyKubernetesDeployment({
				spec: { replicas: 2 },
				status: { readyReplicas: 1 },
			} as never),
		).toBe("pending");
		expect(
			classifyKubernetesDeployment({
				spec: { replicas: 2 },
				status: { readyReplicas: 2 },
			} as never),
		).toBe("ready");
		expect(
			classifyKubernetesDeployment({
				status: {
					conditions: [
						{
							type: "Progressing",
							status: "False",
							reason: "ProgressDeadlineExceeded",
						},
					],
				},
			} as never),
		).toBe("failed");
	});
});
