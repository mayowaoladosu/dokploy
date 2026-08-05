import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	PlatformBuildPool,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import {
	buildKubernetesBuildNamespace,
	createKubernetesBuildExecutor,
} from "@dokploy/server/services/kubernetes/build-executor";
import type { KubernetesControlPlane } from "@dokploy/server/services/kubernetes/client";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { afterEach, describe, expect, it, vi } from "vitest";

const logFiles: string[] = [];

afterEach(async () => {
	await Promise.all(
		logFiles.splice(0).map((file) => fs.rm(file, { force: true })),
	);
});

describe("Kubernetes build executor", () => {
	it("captures a registry digest from ephemeral job termination metadata", async () => {
		const apply = vi.fn(async () => undefined);
		const client: KubernetesControlPlane = {
			apply,
			delete: vi.fn(async () => undefined),
			readDeployment: vi.fn(async () => null),
			readJob: vi.fn(async () => ({ status: { succeeded: 1 } }) as never),
			listPods: vi.fn(
				async () =>
					[
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
					] as never,
			),
			readPodLogs: vi.fn(async () => "build output"),
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
			builderImage: `registry.example.com/platform/builder@sha256:${"c".repeat(64)}`,
			runtimeClassName: "gvisor",
			registryHost: "registry.example.com",
			registryRepositoryPrefix: "apps",
			registryAuthMode: "workload_identity",
		} as PlatformBuildPool;
		const executor = createKubernetesBuildExecutor({
			client,
			placement,
			clusterMetadata: {},
			buildPool,
			nodePool: null,
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
			command: "set -e; echo build",
			logPath,
			buildServerId: null,
		});

		expect(artifact).toMatchObject({
			imageId: `sha256:${"a".repeat(64)}`,
			imageDigest: `sha256:${"b".repeat(64)}`,
			imageRef: `registry.example.com/apps/application-1@sha256:${"b".repeat(64)}`,
			imageSizeBytes: 4096,
			executor: "kubernetes-job",
		});
		expect(apply).toHaveBeenCalledTimes(1);
		expect(client.delete).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "Secret" }),
		);
		expect(await fs.readFile(logPath, "utf8")).toContain("build output");

		const previewApplication = {
			...application,
			releaseIdentity: "preview-42",
		};
		await executor.cancel({
			deploymentId: "deployment-42",
			buildServerId: null,
			application: previewApplication,
		});
		expect(client.delete).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "Job",
				metadata: expect.objectContaining({
					namespace: buildKubernetesBuildNamespace(
						"organization-1",
						"preview-42",
					),
				}),
			}),
		);
	});
});
