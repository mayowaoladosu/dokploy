import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type {
	PlatformBuildPool,
	PlatformClusterMetadata,
	PlatformNodePool,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { findBitbucketById } from "@dokploy/server/services/bitbucket";
import { findGiteaById } from "@dokploy/server/services/gitea";
import { findGithubById } from "@dokploy/server/services/github";
import { findGitlabById } from "@dokploy/server/services/gitlab";
import { findSSHKeyById } from "@dokploy/server/services/ssh-key";
import { getBitbucketCredentialEnvironmentNames } from "@dokploy/server/utils/providers/bitbucket";
import { getDockerSourceCredentialEnvironmentNames } from "@dokploy/server/utils/providers/docker";
import { getCustomGitCredentialEnvironmentNames } from "@dokploy/server/utils/providers/git";
import {
	getGiteaTokenEnvironmentName,
	refreshGiteaToken,
} from "@dokploy/server/utils/providers/gitea";
import {
	authGithub,
	getGithubToken,
	getGithubTokenEnvironmentName,
} from "@dokploy/server/utils/providers/github";
import {
	getGitlabTokenEnvironmentName,
	refreshGitlabToken,
} from "@dokploy/server/utils/providers/gitlab";
import type { KubernetesObject, V1Pod } from "@kubernetes/client-node";
import { quote } from "shell-quote";
import { z } from "zod";
import {
	type BuildExecutionArtifact,
	type BuildExecutor,
	selectImmutableImageRef,
} from "../build-executor";
import type { KubernetesControlPlane } from "./client";
import {
	buildKubernetesBuildManifests,
	type KubernetesResourceSpec,
	kubernetesManifestName,
} from "./manifests";

type KubernetesBuildExecutorInput = {
	client: KubernetesControlPlane;
	placement: PlatformPlacement;
	clusterMetadata: PlatformClusterMetadata;
	buildPool: PlatformBuildPool;
	nodePool: PlatformNodePool | null;
	pollIntervalMs?: number;
	sleep?: (durationMs: number) => Promise<void>;
};

const buildTerminationMessage = z.object({
	imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	repoDigests: z
		.array(z.string().regex(/^[^\s@]+@sha256:[a-f0-9]{64}$/))
		.max(100)
		.nullable(),
	imageSizeBytes: z
		.number()
		.int()
		.positive()
		.max(100 * 1024 ** 3),
});

const defaultSleep = (durationMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, durationMs));

export const buildKubernetesBuildNamespace = (
	organizationId: string,
	applicationId: string,
) => {
	const digest = createHash("sha256")
		.update(`${organizationId}:${applicationId}:build`)
		.digest("hex")
		.slice(0, 20);
	return `vlyv-build-${digest}`;
};

const buildResources = (): KubernetesResourceSpec => ({
	memoryLimitBytes: Number.parseInt(
		process.env.PLATFORM_BUILD_MEMORY_LIMIT_BYTES || String(4 * 1024 ** 3),
		10,
	),
	memoryRequestBytes: Number.parseInt(
		process.env.PLATFORM_BUILD_MEMORY_REQUEST_BYTES || String(512 * 1024 ** 2),
		10,
	),
	cpuLimitNano: Number.parseInt(
		process.env.PLATFORM_BUILD_CPU_LIMIT_NANO || "4000000000",
		10,
	),
	cpuRequestNano: Number.parseInt(
		process.env.PLATFORM_BUILD_CPU_REQUEST_NANO || "500000000",
		10,
	),
	ephemeralStorageLimitBytes: Number.parseInt(
		process.env.PLATFORM_BUILD_EPHEMERAL_STORAGE_LIMIT_BYTES ||
			String(20 * 1024 ** 3),
		10,
	),
	ephemeralStorageRequestBytes: Number.parseInt(
		process.env.PLATFORM_BUILD_EPHEMERAL_STORAGE_REQUEST_BYTES ||
			String(2 * 1024 ** 3),
		10,
	),
});

const terminatedBuilder = (pods: V1Pod[]) => {
	for (const pod of pods) {
		const terminated = pod.status?.containerStatuses?.find(
			(container) => container.name === "builder",
		)?.state?.terminated;
		if (terminated) return { pod, terminated };
	}
	return null;
};

const registrySecretsFor = async (buildPool: PlatformBuildPool) => {
	const secrets: Record<string, string> = {};
	if (buildPool.registryAuthMode === "basic") {
		secrets.VLYV_PLATFORM_REGISTRY_HOST = buildPool.registryHost || "";
		secrets.VLYV_PLATFORM_REGISTRY_USERNAME = buildPool.registryUsername || "";
		secrets.VLYV_PLATFORM_REGISTRY_PASSWORD = buildPool.registryPassword || "";
	}
	return secrets;
};

export const buildPoolImageRef = (
	buildPool: Pick<
		PlatformBuildPool,
		"registryHost" | "registryRepositoryPrefix"
	>,
	applicationId: string,
	deploymentId: string,
) => {
	const host = buildPool.registryHost
		?.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	const prefix = buildPool.registryRepositoryPrefix
		?.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	if (!host || !prefix) {
		throw new Error("The selected build pool has no artifact registry");
	}
	const repository = applicationId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
	const tag = deploymentId.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
	return `${host}/${prefix}/${repository}:${tag}`;
};

const platformRegistryPushCommand = ({
	buildPool,
	localImageRef,
	runtimeImageRef,
}: {
	buildPool: PlatformBuildPool;
	localImageRef: string;
	runtimeImageRef: string;
}) => `
${
	buildPool.registryAuthMode === "basic"
		? 'printf %s "$VLYV_PLATFORM_REGISTRY_PASSWORD" | docker login "$VLYV_PLATFORM_REGISTRY_HOST" -u "$VLYV_PLATFORM_REGISTRY_USERNAME" --password-stdin'
		: "true"
}
docker tag ${quote([localImageRef])} ${quote([runtimeImageRef])}
docker push ${quote([runtimeImageRef])}
`;

const sourceSecretsFor = async (
	application: Parameters<BuildExecutor["execute"]>[0]["application"],
) => {
	const secrets: Record<string, string> = {};
	if (application.sourceType === "github" && application.githubId) {
		const provider = await findGithubById(application.githubId);
		secrets[getGithubTokenEnvironmentName(application.githubId)] =
			await getGithubToken(authGithub(provider));
	}
	if (application.sourceType === "gitlab" && application.gitlabId) {
		await refreshGitlabToken(application.gitlabId);
		const provider = await findGitlabById(application.gitlabId);
		if (provider.accessToken) {
			secrets[getGitlabTokenEnvironmentName(application.gitlabId)] =
				provider.accessToken;
		}
	}
	if (application.sourceType === "gitea" && application.giteaId) {
		await refreshGiteaToken(application.giteaId);
		const provider = await findGiteaById(application.giteaId);
		if (provider.accessToken) {
			secrets[getGiteaTokenEnvironmentName(application.giteaId)] =
				provider.accessToken;
		}
	}
	if (application.sourceType === "bitbucket" && application.bitbucketId) {
		const provider = await findBitbucketById(application.bitbucketId);
		const names = getBitbucketCredentialEnvironmentNames(
			application.bitbucketId,
		);
		secrets[names.username] = provider.bitbucketUsername || "";
		secrets[names.password] = provider.apiToken || provider.appPassword || "";
	}
	if (application.sourceType === "git") {
		if (application.customGitSSHKeyId) {
			const key = await findSSHKeyById(application.customGitSSHKeyId);
			const names = getCustomGitCredentialEnvironmentNames(
				application.customGitSSHKeyId,
			);
			secrets[names.privateKey] = key.privateKey;
		} else if (application.customGitUrl) {
			const parsed = new URL(application.customGitUrl);
			if (parsed.username || parsed.password) {
				const names = getCustomGitCredentialEnvironmentNames();
				secrets[names.username] = decodeURIComponent(parsed.username);
				secrets[names.password] = decodeURIComponent(parsed.password);
			}
		}
	}
	if (
		application.sourceType === "docker" &&
		application.username &&
		application.password
	) {
		const names = getDockerSourceCredentialEnvironmentNames();
		secrets[names.url] = application.registryUrl || "";
		secrets[names.username] = application.username;
		secrets[names.password] = application.password;
	}
	return secrets;
};

const parseTerminationMessage = (message: string | undefined) => {
	if (!message) throw new Error("Build job did not report artifact metadata");
	if (Buffer.byteLength(message, "utf8") > 16 * 1024) {
		throw new Error("Build job artifact metadata exceeded the size limit");
	}
	try {
		return buildTerminationMessage.parse(JSON.parse(message));
	} catch {
		throw new Error("Build job returned invalid artifact metadata");
	}
};

export const createKubernetesBuildExecutor = ({
	client,
	placement,
	clusterMetadata,
	buildPool,
	nodePool,
	pollIntervalMs = 2_000,
	sleep = defaultSleep,
}: KubernetesBuildExecutorInput): BuildExecutor => {
	const builderImage = buildPool.builderImage;
	if (!builderImage) {
		throw new Error(
			"Kubernetes cluster metadata must configure a rootless builderImage",
		);
	}

	const waitForBuild = async (
		namespace: string,
		jobName: string,
		timeoutMs: number,
	) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const job = await client.readJob(namespace, jobName);
			if (job?.status?.failed && job.status.failed > 0) {
				const pods = await client.listPods(namespace, `job-name=${jobName}`);
				const pod = pods[0];
				const logs = pod?.metadata?.name
					? await client.readPodLogs(namespace, pod.metadata.name, "builder")
					: "";
				throw new Error(
					`Kubernetes build job failed${logs ? `: ${logs.slice(-4000)}` : ""}`,
				);
			}
			if (job?.status?.succeeded && job.status.succeeded > 0) {
				const pods = await client.listPods(namespace, `job-name=${jobName}`);
				const result = terminatedBuilder(pods);
				if (!result) {
					throw new Error(
						"Kubernetes build completed without container status",
					);
				}
				if (result.terminated.exitCode !== 0) {
					throw new Error(
						result.terminated.message ||
							"Kubernetes builder exited unsuccessfully",
					);
				}
				return {
					message: parseTerminationMessage(result.terminated.message),
					podName: result.pod.metadata?.name ?? null,
					logs: result.pod.metadata?.name
						? await client.readPodLogs(
								namespace,
								result.pod.metadata.name,
								"builder",
							)
						: "",
				};
			}
			await sleep(pollIntervalMs);
		}
		throw new Error(`Kubernetes build did not finish within ${timeoutMs}ms`);
	};

	return {
		name: "kubernetes-job",
		isolation: "ephemeral",
		execute: async (input): Promise<BuildExecutionArtifact> => {
			const startedAt = Date.now();
			const releaseIdentity =
				input.application.releaseIdentity || input.application.applicationId;
			const namespace = buildKubernetesBuildNamespace(
				input.application.environment.project.organizationId,
				releaseIdentity,
			);
			const jobName = kubernetesManifestName(`build-${input.deploymentId}`);
			const runtimeImageRef = buildPoolImageRef(
				buildPool,
				releaseIdentity,
				input.deploymentId,
			);
			const localImageRef =
				input.application.sourceType === "docker"
					? input.application.dockerImage || ""
					: `${input.application.appName}:latest`;
			if (!localImageRef) throw new Error("Docker source image is required");
			const timeoutMs = Number.parseInt(
				process.env.PLATFORM_BUILD_TIMEOUT_MS || "900000",
				10,
			);
			const completionTimeoutMs = timeoutMs + 30_000;
			const secrets = {
				...(await registrySecretsFor(buildPool)),
				...(await sourceSecretsFor(input.application)),
			};
			const manifests = buildKubernetesBuildManifests({
				applicationId: releaseIdentity,
				organizationId: input.application.environment.project.organizationId,
				deploymentId: input.deploymentId,
				namespace,
				appName: input.application.appName,
				builderImage,
				command: `${input.command}\n${platformRegistryPushCommand({
					buildPool,
					localImageRef,
					runtimeImageRef,
				})}`,
				localImageRef: runtimeImageRef,
				runtimeImageRef,
				runtimeClassName:
					nodePool?.runtimeClassName || clusterMetadata.buildRuntimeClassName,
				nodeSelector: nodePool?.labels,
				tolerations: nodePool?.taints,
				activeDeadlineSeconds: Math.max(
					Math.ceil(completionTimeoutMs / 1000),
					60,
				),
				resources: buildResources(),
				secrets,
				allowedEgressCidrs: clusterMetadata.allowedEgressCidrs,
			});
			const credentialSecret = manifests.find(
				(manifest) => manifest.kind === "Secret",
			);
			let result: Awaited<ReturnType<typeof waitForBuild>>;
			try {
				await client.apply(manifests);
				result = await waitForBuild(namespace, jobName, completionTimeoutMs);
			} finally {
				if (credentialSecret) {
					await client
						.delete(credentialSecret)
						.catch((error) =>
							console.error(
								"Failed to delete Kubernetes build credentials",
								error,
							),
						);
				}
			}
			if (result.logs) {
				await fs.appendFile(input.logPath, `${result.logs}\n`);
			}
			const immutable = selectImmutableImageRef({
				runtimeImageRef,
				imageId: result.message.imageId,
				repoDigests: result.message.repoDigests ?? [],
			});
			if (!immutable.isRegistryDigest) {
				throw new Error(
					"Kubernetes releases require a registry-backed immutable image digest",
				);
			}
			return {
				imageId: result.message.imageId,
				imageDigest: immutable.imageDigest,
				imageRef: immutable.imageRef,
				imageSizeBytes: result.message.imageSizeBytes,
				builder: input.application.buildType,
				executor: "kubernetes-job",
				durationMs: Date.now() - startedAt,
				metadata: {
					clusterId: buildPool.clusterId,
					buildPoolId: buildPool.buildPoolId,
					namespace,
					jobName,
					podName: result.podName,
					runtimeImageRef,
				},
			};
		},
		cancel: async ({ deploymentId, application }) => {
			const namespace = buildKubernetesBuildNamespace(
				placement.organizationId,
				application.releaseIdentity || application.applicationId,
			);
			const job: KubernetesObject = {
				apiVersion: "batch/v1",
				kind: "Job",
				metadata: {
					name: kubernetesManifestName(`build-${deploymentId}`),
					namespace,
				},
			};
			await client.delete(job);
		},
	};
};
