import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	PlatformBuildPool,
	PlatformObjectStorage,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { buildOutputManifestDigest } from "@dokploy/server/services/build-output-manifest";
import {
	assertSupplyChainPolicy,
	buildKubernetesBuildNamespace,
	createKubernetesBuildExecutor,
	partitionBuildManifests,
} from "@dokploy/server/services/kubernetes/build-executor";
import type { KubernetesControlPlane } from "@dokploy/server/services/kubernetes/client";
import { staticAssetObjectPrefix } from "@dokploy/server/services/static-object-storage";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { afterEach, describe, expect, it, vi } from "vitest";

const logFiles: string[] = [];
const outputManifestBytes = Buffer.from(
	JSON.stringify({
		version: 1,
		framework: { name: "vite", version: "6.0.0" },
		mode: "static",
		staticDirectories: [
			{ directory: "dist", routePrefix: "/", cachePolicy: "revalidate" },
		],
		functions: [],
		isr: [],
		redirects: [],
		headers: [],
		edgeMiddleware: [],
		staticOutput: { fileCount: 1, totalBytes: 42 },
		metadata: { adapter: "static", generatedAt: "2026-08-05T00:00:00.000Z" },
	}),
);
const outputManifestDigest = buildOutputManifestDigest(outputManifestBytes);
const outputObjectPrefix = staticAssetObjectPrefix({
	basePrefix: "assets",
	organizationId: "organization-1",
	applicationId: "application-1",
	deploymentId: "deployment-1",
});

afterEach(async () => {
	await Promise.all(
		logFiles.splice(0).map((file) => fs.rm(file, { force: true })),
	);
});

describe("Kubernetes build executor", () => {
	it("applies namespace isolation before build workloads", () => {
		const partition = partitionBuildManifests([
			{ kind: "Secret" },
			{ kind: "NetworkPolicy" },
			{ kind: "Job" },
			{ kind: "Namespace" },
			{ kind: "PersistentVolumeClaim" },
		]);

		expect(partition.prerequisites.map((manifest) => manifest.kind)).toEqual([
			"NetworkPolicy",
			"Namespace",
			"PersistentVolumeClaim",
		]);
		expect(partition.workloads.map((manifest) => manifest.kind)).toEqual([
			"Secret",
			"Job",
		]);
	});

	it("rejects verifier counts above the configured policy", () => {
		expect(() =>
			assertSupplyChainPolicy(
				{
					sbomDigest: `sha256:${"a".repeat(64)}`,
					vulnerabilityReportDigest: `sha256:${"b".repeat(64)}`,
					criticalVulnerabilities: 1,
					highVulnerabilities: 0,
					signed: true,
					signatureVerified: true,
				},
				{ maxCriticalVulnerabilities: 0, maxHighVulnerabilities: 0 },
			),
		).toThrow("critical vulnerability policy");
	});

	it("captures a registry digest from ephemeral job termination metadata", async () => {
		const apply = vi.fn<KubernetesControlPlane["apply"]>(async () => undefined);
		const client: KubernetesControlPlane = {
			apply,
			read: vi.fn(async () => null),
			delete: vi.fn(async () => undefined),
			readDeployment: vi.fn(async () => null),
			readJob: vi.fn(async () => ({ status: { succeeded: 1 } }) as never),
			listPods: vi.fn(async (_namespace, selector) => {
				if (selector.includes("output-")) {
					return [
						{
							metadata: { name: "output-publisher-pod" },
							status: {
								containerStatuses: [
									{
										name: "output-publisher",
										state: {
											terminated: {
												exitCode: 0,
												message: JSON.stringify({
													manifestDigest: outputManifestDigest,
													objectPrefix: outputObjectPrefix,
													publicBaseUrl: `https://assets.example.com/${outputObjectPrefix}`,
													fileCount: 1,
													totalBytes: 42,
												}),
											},
										},
									},
								],
							},
						},
					] as never;
				}
				if (selector.includes("verify-")) {
					return [
						{
							metadata: { name: "verifier-pod" },
							status: {
								containerStatuses: [
									{
										name: "verifier",
										state: {
											terminated: {
												exitCode: 0,
												message: JSON.stringify({
													sbomDigest: `sha256:${"d".repeat(64)}`,
													vulnerabilityReportDigest: `sha256:${"e".repeat(64)}`,
													criticalVulnerabilities: 0,
													highVulnerabilities: 0,
													signed: true,
													signatureVerified: true,
												}),
											},
										},
									},
								],
							},
						},
					] as never;
				}
				if (selector.includes("publish-")) {
					return [
						{
							metadata: { name: "publisher-pod" },
							status: {
								containerStatuses: [
									{
										name: "publisher",
										state: {
											terminated: {
												exitCode: 0,
												message: JSON.stringify({
													imageId: `sha256:${"a".repeat(64)}`,
													repoDigests: [
														`registry.example.com/apps/application-1@sha256:${"b".repeat(64)}`,
													],
													imageSizeBytes: 4096,
												}),
											},
										},
									},
								],
							},
						},
					] as never;
				}
				return [
					{
						metadata: { name: "builder-pod" },
						status: {
							containerStatuses: [
								{
									name: "builder",
									state: {
										terminated: {
											exitCode: 0,
											message: JSON.stringify({
												imageId: `sha256:${"a".repeat(64)}`,
												imageSizeBytes: 4096,
												outputManifestDigest,
												outputFileCount: 1,
												outputTotalBytes: 42,
											}),
										},
									},
								},
							],
						},
					},
				] as never;
			}),
			listPodMetrics: vi.fn(async () => []),
			readPodLogs: vi.fn(
				async (_namespace, _pod, container) => `${container} output`,
			),
			setDeploymentReplicas: vi.fn(async () => undefined),
			restartDeployment: vi.fn(async () => undefined),
			deleteNamespace: vi.fn(async () => undefined),
		};
		const placement = {
			applicationId: "application-1",
			organizationId: "organization-1",
		} as PlatformPlacement;
		const buildPool = {
			buildPoolId: "build-pool-1",
			clusterId: "cluster-1",
			runtime: "kubernetes",
			status: "active",
			builderImage: `registry.example.com/platform/builder@sha256:${"c".repeat(64)}`,
			runtimeClassName: "gvisor",
			registryHost: "registry.example.com",
			registryRepositoryPrefix: "apps",
			registryAuthMode: "workload_identity",
			metadata: {
				registryCredentialHelperConfigured: true,
				runtimeImagePullIdentityConfigured: true,
				rootlessBuilderValidated: true,
				supplyChain: {
					verifierImage: `registry.example.com/platform/verifier@sha256:${"f".repeat(64)}`,
					outputPublisherImage: `registry.example.com/platform/output-publisher@sha256:${"e".repeat(64)}`,
					signingKeyRef: "awskms:///alias/vlyv-image-signing",
					maxCriticalVulnerabilities: 0,
					maxHighVulnerabilities: 0,
					ignoreUnfixed: false,
					artifactStorageClassName: "encrypted-ephemeral",
				},
			},
		} as PlatformBuildPool;
		const executor = createKubernetesBuildExecutor({
			client,
			placement,
			clusterMetadata: {},
			buildPool,
			nodePool: {
				labels: { "vlyv.dev/pool": "build" },
				runtimeClassName: "gvisor",
			} as never,
			objectStorage: {
				objectStorageId: "object-storage-1",
				provider: "s3",
				status: "active",
				endpoint: "https://s3.example.com",
				region: "us-east-1",
				bucket: "vlyv-assets",
				accessKeyId: "access-key",
				secretAccessKey: "secret-key",
				publicBaseUrl: "https://assets.example.com",
				prefix: "assets",
				metadata: {},
			} as PlatformObjectStorage,
			outputPublicationStore: {
				getManifest: vi.fn(async () => outputManifestBytes),
				record: vi.fn(async () => undefined),
				deletePrefix: vi.fn(async () => undefined),
				removeRecord: vi.fn(async () => undefined),
			},
		});
		const application = {
			applicationId: "application-1",
			appName: "example-app",
			sourceType: "git",
			buildType: "railpack",
			environmentId: "environment-1",
			environment: {
				project: {
					projectId: "project-1",
					organizationId: "organization-1",
				},
			},
		} as unknown as ApplicationNested;
		const logPath = path.join(
			os.tmpdir(),
			`vlyv-kubernetes-build-${Date.now()}.log`,
		);
		logFiles.push(logPath);
		await fs.writeFile(logPath, "Initializing deployment\n");

		const artifact = await executor.execute({
			application,
			deploymentId: "deployment-1",
			sourceCommand: "set -e; echo clone",
			buildCommand: "set -e; echo build",
			logPath,
			buildServerId: null,
		});

		expect(artifact).toMatchObject({
			imageId: `sha256:${"a".repeat(64)}`,
			imageDigest: `sha256:${"b".repeat(64)}`,
			imageRef: `registry.example.com/apps/application-1@sha256:${"b".repeat(64)}`,
			imageSizeBytes: 4096,
			executor: "kubernetes-job",
			metadata: {
				supplyChain: {
					sbomDigest: `sha256:${"d".repeat(64)}`,
					vulnerabilityReportDigest: `sha256:${"e".repeat(64)}`,
					criticalVulnerabilities: 0,
					highVulnerabilities: 0,
					signed: true,
					signatureVerified: true,
				},
			},
		});
		expect(apply).toHaveBeenCalledTimes(5);
		const builderWorkloads = apply.mock.calls.find(([manifests]) =>
			manifests.some(
				(manifest: { kind?: string; metadata?: { name?: string } }) =>
					manifest.kind === "Job" &&
					manifest.metadata?.name?.startsWith("build-"),
			),
		)?.[0];
		expect(builderWorkloads).toBeDefined();
		expect(client.delete).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "Secret" }),
		);
		const logs = await fs.readFile(logPath, "utf8");
		expect(logs).toContain("builder output");
		expect(logs).toContain("publisher output");
		expect(logs).toContain("verifier output");
		expect(logs).toContain("output-publisher output");

		const previewApplication = {
			...application,
			releaseIdentity: "preview-42",
		};
		await executor.cancel({
			deploymentId: "deployment-42",
			buildServerId: null,
			application: previewApplication,
		});
		expect(client.deleteNamespace).toHaveBeenLastCalledWith(
			buildKubernetesBuildNamespace(
				"organization-1",
				"preview-42",
				"deployment-42",
			),
		);
	});
});
