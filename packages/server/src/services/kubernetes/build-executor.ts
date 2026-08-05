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
import { assertBuildPoolReadiness } from "@dokploy/server/services/platform-infrastructure";
import { findSSHKeyById } from "@dokploy/server/services/ssh-key";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
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
import type { V1Pod } from "@kubernetes/client-node";
import { z } from "zod";
import {
	type BuildExecutionArtifact,
	type BuildExecutor,
	selectImmutableImageRef,
} from "../build-executor";
import type { KubernetesControlPlane } from "./client";
import {
	buildKubernetesBuildManifests,
	buildKubernetesPublisherManifests,
	buildKubernetesSupplyChainManifests,
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

const buildArchiveTerminationMessage = z.object({
	imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	imageSizeBytes: z
		.number()
		.int()
		.positive()
		.max(100 * 1024 ** 3),
});

const supplyChainTerminationMessage = z.object({
	sbomDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	vulnerabilityReportDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	criticalVulnerabilities: z.number().int().nonnegative().max(1_000_000),
	highVulnerabilities: z.number().int().nonnegative().max(1_000_000),
	signed: z.literal(true),
	signatureVerified: z.literal(true),
});

const defaultSleep = (durationMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const BUILD_PREREQUISITE_KINDS = new Set([
	"Namespace",
	"ResourceQuota",
	"LimitRange",
	"NetworkPolicy",
	"PersistentVolumeClaim",
]);

export const partitionBuildManifests = <T extends { kind?: string }>(
	manifests: T[],
) => ({
	prerequisites: manifests.filter((manifest) =>
		BUILD_PREREQUISITE_KINDS.has(manifest.kind || ""),
	),
	workloads: manifests.filter(
		(manifest) => !BUILD_PREREQUISITE_KINDS.has(manifest.kind || ""),
	),
});

const positiveIntegerEnvironment = (name: string, fallback: number) => {
	const parsed = Number.parseInt(process.env[name] || "", 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const buildKubernetesBuildNamespace = (
	organizationId: string,
	applicationId: string,
	deploymentId: string,
) => {
	const digest = createHash("sha256")
		.update(`${organizationId}:${applicationId}:${deploymentId}:build`)
		.digest("hex")
		.slice(0, 20);
	return `vlyv-build-${digest}`;
};

const buildResources = (): KubernetesResourceSpec => ({
	memoryLimitBytes: positiveIntegerEnvironment(
		"PLATFORM_BUILD_MEMORY_LIMIT_BYTES",
		4 * 1024 ** 3,
	),
	memoryRequestBytes: positiveIntegerEnvironment(
		"PLATFORM_BUILD_MEMORY_REQUEST_BYTES",
		512 * 1024 ** 2,
	),
	cpuLimitNano: positiveIntegerEnvironment(
		"PLATFORM_BUILD_CPU_LIMIT_NANO",
		4_000_000_000,
	),
	cpuRequestNano: positiveIntegerEnvironment(
		"PLATFORM_BUILD_CPU_REQUEST_NANO",
		500_000_000,
	),
	ephemeralStorageLimitBytes: positiveIntegerEnvironment(
		"PLATFORM_BUILD_EPHEMERAL_STORAGE_LIMIT_BYTES",
		20 * 1024 ** 3,
	),
	ephemeralStorageRequestBytes: positiveIntegerEnvironment(
		"PLATFORM_BUILD_EPHEMERAL_STORAGE_REQUEST_BYTES",
		2 * 1024 ** 3,
	),
});

const terminatedContainer = (pods: V1Pod[], containerName: string) => {
	for (const pod of pods) {
		const terminated = pod.status?.containerStatuses?.find(
			(container) => container.name === containerName,
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

const parseBuildArchiveTerminationMessage = (message: string | undefined) => {
	if (!message) throw new Error("Build job did not report archive metadata");
	if (Buffer.byteLength(message, "utf8") > 16 * 1024) {
		throw new Error("Build archive metadata exceeded the size limit");
	}
	try {
		return buildArchiveTerminationMessage.parse(JSON.parse(message));
	} catch {
		throw new Error("Build job returned invalid archive metadata");
	}
};

const parseSupplyChainTerminationMessage = (message: string | undefined) => {
	if (!message) {
		throw new Error(
			"Supply-chain verifier did not report attestation metadata",
		);
	}
	if (Buffer.byteLength(message, "utf8") > 16 * 1024) {
		throw new Error(
			"Supply-chain attestation metadata exceeded the size limit",
		);
	}
	try {
		return supplyChainTerminationMessage.parse(JSON.parse(message));
	} catch {
		throw new Error("Supply-chain verifier returned invalid metadata");
	}
};

export const assertSupplyChainPolicy = (
	result: z.infer<typeof supplyChainTerminationMessage>,
	policy: {
		maxCriticalVulnerabilities: number;
		maxHighVulnerabilities: number;
	},
) => {
	if (result.criticalVulnerabilities > policy.maxCriticalVulnerabilities) {
		throw new Error("Image rejected by critical vulnerability policy");
	}
	if (result.highVulnerabilities > policy.maxHighVulnerabilities) {
		throw new Error("Image rejected by high vulnerability policy");
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
	assertBuildPoolReadiness({ ...buildPool, nodePool });
	const builderImage = buildPool.builderImage;
	if (!builderImage) {
		throw new Error(
			"Kubernetes build pool must configure a rootless builderImage",
		);
	}

	const waitForJob = async <T>(
		namespace: string,
		jobName: string,
		containerName: string,
		timeoutMs: number,
		parseMessage: (message: string | undefined) => T,
		logContainerNames: string[] = [containerName],
	) => {
		const readLogs = async (podName: string | undefined) => {
			if (!podName) return "";
			const logs = await Promise.all(
				logContainerNames.map(async (name) => {
					const output = await client
						.readPodLogs(namespace, podName, name)
						.catch(() => "");
					return output ? `[${name}]\n${output}` : "";
				}),
			);
			return logs.filter(Boolean).join("\n");
		};
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const job = await client.readJob(namespace, jobName);
			if (job?.status?.failed && job.status.failed > 0) {
				const pods = await client.listPods(namespace, `job-name=${jobName}`);
				const pod = pods[0];
				const logs = await readLogs(pod?.metadata?.name);
				throw new Error(
					`Kubernetes ${containerName} job failed${logs ? `: ${logs.slice(-4000)}` : ""}`,
				);
			}
			if (job?.status?.succeeded && job.status.succeeded > 0) {
				const pods = await client.listPods(namespace, `job-name=${jobName}`);
				const result = terminatedContainer(pods, containerName);
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
					message: parseMessage(result.terminated.message),
					podName: result.pod.metadata?.name ?? null,
					logs: await readLogs(result.pod.metadata?.name),
				};
			}
			await sleep(pollIntervalMs);
		}
		throw new Error(
			`Kubernetes ${containerName} job did not finish within ${timeoutMs}ms`,
		);
	};

	return {
		name: "kubernetes-job",
		isolation: "ephemeral",
		execute: async (input): Promise<BuildExecutionArtifact> => {
			const startedAt = Date.now();
			if (input.application.sourceType === "drop") {
				throw new Error(
					"Drop uploads are unavailable for isolated Kubernetes builds",
				);
			}
			const releaseIdentity =
				input.application.releaseIdentity || input.application.applicationId;
			const namespace = buildKubernetesBuildNamespace(
				input.application.environment.project.organizationId,
				releaseIdentity,
				input.deploymentId,
			);
			const buildJobName = kubernetesManifestName(
				`build-${input.deploymentId}`,
			);
			const publisherJobName = kubernetesManifestName(
				`publish-${input.deploymentId}`,
			);
			const verifierJobName = kubernetesManifestName(
				`verify-${input.deploymentId}`,
			);
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
			const timeoutMs = positiveIntegerEnvironment(
				"PLATFORM_BUILD_TIMEOUT_MS",
				900_000,
			);
			const completionTimeoutMs = timeoutMs + 30_000;
			const supplyChainTimeoutMs = positiveIntegerEnvironment(
				"PLATFORM_SUPPLY_CHAIN_TIMEOUT_MS",
				600_000,
			);
			const supplyChain = buildPool.metadata.supplyChain;
			if (!supplyChain) {
				throw new Error("The selected build pool has no supply-chain policy");
			}
			const registrySecrets = await registrySecretsFor(buildPool);
			const sourceSecrets = await sourceSecretsFor(input.application);
			const buildSecrets = getEnvironmentVariablesObject(
				input.application.env,
				input.application.environment.project.env,
				input.application.environment.env,
			);
			const buildManifests = buildKubernetesBuildManifests({
				applicationId: releaseIdentity,
				organizationId: input.application.environment.project.organizationId,
				deploymentId: input.deploymentId,
				namespace,
				appName: input.application.appName,
				builderImage,
				sourceCommand: input.sourceCommand,
				buildCommand: input.buildCommand,
				sourceRunsInBuilder: input.application.sourceType === "docker",
				localImageRef,
				runtimeClassName:
					nodePool?.runtimeClassName || clusterMetadata.buildRuntimeClassName,
				nodeSelector: nodePool?.labels,
				tolerations: nodePool?.taints,
				activeDeadlineSeconds: Math.max(
					Math.ceil(completionTimeoutMs / 1000),
					60,
				),
				resources: buildResources(),
				artifactStorageClassName: supplyChain.artifactStorageClassName,
				sourceSecrets,
				buildSecrets,
				allowedEgressCidrs: clusterMetadata.allowedEgressCidrs,
			});
			const buildCredentialSecrets = buildManifests.filter(
				(manifest) => manifest.kind === "Secret",
			);
			const buildJob = {
				apiVersion: "batch/v1",
				kind: "Job",
				metadata: { name: buildJobName, namespace },
			};
			try {
				const buildResult = await (async () => {
					try {
						const { prerequisites, workloads } =
							partitionBuildManifests(buildManifests);
						await client.apply(prerequisites);
						await client.apply(workloads);
						return await waitForJob(
							namespace,
							buildJobName,
							"builder",
							completionTimeoutMs,
							parseBuildArchiveTerminationMessage,
							["source-fetcher", "builder"],
						);
					} finally {
						await Promise.allSettled([
							...buildCredentialSecrets.map((manifest) =>
								client.delete(manifest),
							),
							client.delete(buildJob),
						]);
					}
				})();
				if (buildResult.logs) {
					await fs.appendFile(input.logPath, `${buildResult.logs}\n`);
				}

				const publisherManifests = buildKubernetesPublisherManifests({
					applicationId: releaseIdentity,
					organizationId: input.application.environment.project.organizationId,
					deploymentId: input.deploymentId,
					namespace,
					publisherImage: supplyChain.verifierImage,
					runtimeImageRef,
					runtimeClassName:
						nodePool?.runtimeClassName ||
						buildPool.runtimeClassName ||
						clusterMetadata.buildRuntimeClassName,
					nodeSelector: nodePool?.labels,
					tolerations: nodePool?.taints,
					serviceAccountAnnotations:
						supplyChain.publisherServiceAccountAnnotations,
					podLabels: supplyChain.publisherPodLabels,
					podAnnotations: supplyChain.publisherPodAnnotations,
					activeDeadlineSeconds: Math.max(
						Math.ceil(completionTimeoutMs / 1000),
						60,
					),
					resources: buildResources(),
					registrySecrets,
				});
				const publisherCredentialSecret = publisherManifests.find(
					(manifest) => manifest.kind === "Secret",
				);
				const publisherServiceAccount = publisherManifests.find(
					(manifest) => manifest.kind === "ServiceAccount",
				);
				const publisherJob = {
					apiVersion: "batch/v1",
					kind: "Job",
					metadata: { name: publisherJobName, namespace },
				};
				const publication = await (async () => {
					try {
						await client.apply(publisherManifests);
						return await waitForJob(
							namespace,
							publisherJobName,
							"publisher",
							completionTimeoutMs,
							parseTerminationMessage,
						);
					} finally {
						await Promise.allSettled([
							...(publisherCredentialSecret
								? [client.delete(publisherCredentialSecret)]
								: []),
							...(publisherServiceAccount
								? [client.delete(publisherServiceAccount)]
								: []),
							client.delete(publisherJob),
						]);
					}
				})();
				if (publication.logs) {
					await fs.appendFile(input.logPath, `${publication.logs}\n`);
				}
				const immutable = selectImmutableImageRef({
					runtimeImageRef,
					imageId: publication.message.imageId,
					repoDigests: publication.message.repoDigests ?? [],
				});
				if (!immutable.isRegistryDigest) {
					throw new Error(
						"Kubernetes releases require a registry-backed immutable image digest",
					);
				}

				const verifierManifests = buildKubernetesSupplyChainManifests({
					applicationId: releaseIdentity,
					organizationId: input.application.environment.project.organizationId,
					deploymentId: input.deploymentId,
					namespace,
					verifierImage: supplyChain.verifierImage,
					imageRef: immutable.imageRef,
					signingKeyRef: supplyChain.signingKeyRef,
					maxCriticalVulnerabilities: supplyChain.maxCriticalVulnerabilities,
					maxHighVulnerabilities: supplyChain.maxHighVulnerabilities,
					ignoreUnfixed: supplyChain.ignoreUnfixed,
					runtimeClassName:
						nodePool?.runtimeClassName ||
						buildPool.runtimeClassName ||
						clusterMetadata.buildRuntimeClassName,
					nodeSelector: nodePool?.labels,
					tolerations: nodePool?.taints,
					serviceAccountAnnotations: supplyChain.serviceAccountAnnotations,
					podLabels: supplyChain.podLabels,
					podAnnotations: supplyChain.podAnnotations,
					activeDeadlineSeconds: Math.max(
						Math.ceil(supplyChainTimeoutMs / 1000),
						60,
					),
					resources: buildResources(),
					registrySecrets,
				});
				const verifierCredentialSecret = verifierManifests.find(
					(manifest) => manifest.kind === "Secret",
				);
				const verifierServiceAccount = verifierManifests.find(
					(manifest) => manifest.kind === "ServiceAccount",
				);
				const verifierJob = {
					apiVersion: "batch/v1",
					kind: "Job",
					metadata: { name: verifierJobName, namespace },
				};
				const verification = await (async () => {
					try {
						await client.apply(verifierManifests);
						return await waitForJob(
							namespace,
							verifierJobName,
							"verifier",
							supplyChainTimeoutMs,
							parseSupplyChainTerminationMessage,
						);
					} finally {
						await Promise.allSettled([
							...(verifierCredentialSecret
								? [client.delete(verifierCredentialSecret)]
								: []),
							...(verifierServiceAccount
								? [client.delete(verifierServiceAccount)]
								: []),
							client.delete(verifierJob),
						]);
					}
				})();
				if (verification.logs) {
					await fs.appendFile(input.logPath, `${verification.logs}\n`);
				}
				assertSupplyChainPolicy(verification.message, supplyChain);

				return {
					imageId: publication.message.imageId,
					imageDigest: immutable.imageDigest,
					imageRef: immutable.imageRef,
					imageSizeBytes: publication.message.imageSizeBytes,
					builder: input.application.buildType,
					executor: "kubernetes-job",
					durationMs: Date.now() - startedAt,
					metadata: {
						clusterId: buildPool.clusterId,
						buildPoolId: buildPool.buildPoolId,
						namespace,
						buildJobName,
						buildPodName: buildResult.podName,
						publisherJobName,
						publisherPodName: publication.podName,
						verifierJobName,
						verifierPodName: verification.podName,
						runtimeImageRef,
						supplyChain: verification.message,
					},
				};
			} finally {
				await client.deleteNamespace(namespace);
			}
		},
		cancel: async ({ deploymentId, application }) => {
			const namespace = buildKubernetesBuildNamespace(
				placement.organizationId,
				application.releaseIdentity || application.applicationId,
				deploymentId,
			);
			await client.deleteNamespace(namespace);
		},
	};
};
