import type {
	PlatformBuildPool,
	PlatformClusterMetadata,
	PlatformNodePool,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { prepareEnvironmentVariables } from "@dokploy/server/utils/docker/utils";
import { findVerifiedDomainsByApplicationId } from "../domain-verification";
import { managedDataEnvironmentForApplication } from "../managed-data-binding";
import {
	observabilityResourceId,
	observabilityTenantId,
} from "../observability";
import { markPlatformPlacementReconciled } from "../platform-infrastructure";
import {
	type RuntimeApplication,
	type RuntimeScheduler,
	type RuntimeStatus,
	verifyHttpEndpoint,
} from "../runtime-scheduler";
import type { KubernetesControlPlane } from "./client";
import {
	buildKubernetesRuntimeManifests,
	type KubernetesDomainRoute,
	type KubernetesHealthCheck,
	type KubernetesResourceSpec,
	kubernetesApplicationResourceName,
	kubernetesReleaseNamespace,
} from "./manifests";

type KubernetesRuntimeSchedulerInput = {
	client: KubernetesControlPlane;
	placement: PlatformPlacement;
	clusterMetadata: PlatformClusterMetadata;
	nodePool: PlatformNodePool | null;
	buildPool: PlatformBuildPool;
	pollIntervalMs?: number;
	sleep?: (durationMs: number) => Promise<void>;
	fetcher?: typeof fetch;
};

const defaultSleep = (durationMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const positiveInteger = (
	value: string | null | undefined,
	fallback: number,
) => {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const boundedSeconds = (
	nanoseconds: number | undefined,
	fallback: number,
	maximum: number,
) => {
	if (!nanoseconds || !Number.isFinite(nanoseconds) || nanoseconds <= 0) {
		return fallback;
	}
	return Math.min(Math.max(Math.ceil(nanoseconds / 1_000_000_000), 1), maximum);
};

export const kubernetesHealthCheckForApplication = (
	application: RuntimeApplication,
): KubernetesHealthCheck | undefined => {
	const port =
		application.ports.find((candidate) => candidate.protocol !== "udp")
			?.targetPort ?? (application.ports.length === 0 ? 3000 : undefined);
	if (!port) return undefined;
	const health = application.healthCheckSwarm;
	const command = health?.Test?.join(" ") ?? "";
	const urlMatch = command.match(
		/https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::(\d{1,5}))?(\/[^\s'"]*)?/i,
	);
	const protocol = urlMatch?.[0]?.toLowerCase().startsWith("https://")
		? "https"
		: urlMatch
			? "http"
			: "tcp";
	const probePort = urlMatch?.[1] ? Number.parseInt(urlMatch[1], 10) : port;
	const periodSeconds = boundedSeconds(health?.Interval, 5, 60);
	const startPeriodSeconds = boundedSeconds(health?.StartPeriod, 120, 600);
	return {
		protocol,
		port: probePort,
		...(protocol === "tcp" ? {} : { path: urlMatch?.[2] || "/" }),
		periodSeconds,
		timeoutSeconds: boundedSeconds(health?.Timeout, 2, 30),
		failureThreshold: Math.max(health?.Retries ?? 3, 1),
		startupFailureThreshold: Math.max(
			Math.ceil(startPeriodSeconds / periodSeconds),
			30,
		),
	};
};

const resourcesFor = (
	application: RuntimeApplication,
): KubernetesResourceSpec => ({
	memoryLimitBytes: positiveInteger(application.memoryLimit, 512 * 1024 * 1024),
	memoryRequestBytes: positiveInteger(
		application.memoryReservation,
		128 * 1024 * 1024,
	),
	cpuLimitNano: positiveInteger(application.cpuLimit, 1_000_000_000),
	cpuRequestNano: positiveInteger(application.cpuReservation, 250_000_000),
	ephemeralStorageLimitBytes: positiveInteger(
		process.env.PLATFORM_RUNTIME_EPHEMERAL_STORAGE_LIMIT_BYTES,
		2 * 1024 ** 3,
	),
	ephemeralStorageRequestBytes: positiveInteger(
		process.env.PLATFORM_RUNTIME_EPHEMERAL_STORAGE_REQUEST_BYTES,
		256 * 1024 ** 2,
	),
});

const verifiedRoutesForApplication = async (
	applicationId: string,
): Promise<KubernetesDomainRoute[]> => {
	return findVerifiedDomainsByApplicationId(applicationId);
};

export const managedDataEnvironmentForRuntimeApplication = async (
	application: Pick<RuntimeApplication, "applicationId" | "releaseIdentity">,
) =>
	application.releaseIdentity
		? []
		: managedDataEnvironmentForApplication(application.applicationId);

export const classifyKubernetesRuntimeDeployment = (
	deployment: Awaited<ReturnType<KubernetesControlPlane["readDeployment"]>>,
	expectedImageRef?: string,
): RuntimeStatus["state"] => {
	if (!deployment) return "missing";
	const failed = deployment.status?.conditions?.find(
		(condition) =>
			condition.type === "Progressing" &&
			condition.status === "False" &&
			condition.reason === "ProgressDeadlineExceeded",
	);
	if (failed) return "failed";
	const desired = deployment.spec?.replicas ?? 1;
	const deployedImage = deployment.spec?.template.spec?.containers[0]?.image;
	if (expectedImageRef && deployedImage !== expectedImageRef) return "pending";
	if (
		expectedImageRef &&
		((deployment.status?.observedGeneration ?? 0) <
			(deployment.metadata?.generation ?? 1) ||
			(deployment.status?.updatedReplicas ?? 0) < desired)
	) {
		return "pending";
	}
	return (deployment.status?.readyReplicas ?? 0) >= desired &&
		(deployment.status?.availableReplicas ?? 0) >= desired
		? "ready"
		: "pending";
};

export const assertVerifiedKubernetesArtifact = (
	artifact: Parameters<RuntimeScheduler["schedule"]>[0]["artifact"],
) => {
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(artifact.imageRef)) {
		throw new Error("Kubernetes runtime requires an immutable image digest");
	}
	const supplyChain = artifact.metadata.supplyChain as
		| {
				sbomDigest?: unknown;
				vulnerabilityReportDigest?: unknown;
				signed?: unknown;
				signatureVerified?: unknown;
		  }
		| undefined;
	if (
		supplyChain?.signed !== true ||
		supplyChain.signatureVerified !== true ||
		typeof supplyChain.sbomDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(supplyChain.sbomDigest) ||
		typeof supplyChain.vulnerabilityReportDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(supplyChain.vulnerabilityReportDigest)
	) {
		throw new Error(
			"Kubernetes runtime requires a signed and verified supply-chain artifact",
		);
	}
};

export const createKubernetesRuntimeScheduler = ({
	client,
	placement,
	clusterMetadata,
	nodePool,
	buildPool,
	pollIntervalMs = 2_000,
	sleep = defaultSleep,
	fetcher = fetch,
}: KubernetesRuntimeSchedulerInput): RuntimeScheduler => {
	const getStatus = async (
		application: RuntimeApplication,
		expectedImageRef?: string,
	): Promise<RuntimeStatus> => {
		const releaseIdentity =
			application.releaseIdentity || application.applicationId;
		const namespace = kubernetesReleaseNamespace({
			applicationId: application.applicationId,
			releaseIdentity: application.releaseIdentity,
			placementNamespace: placement.namespace,
		});
		const deployment = await client.readDeployment(
			namespace,
			kubernetesApplicationResourceName(releaseIdentity),
		);
		const state = classifyKubernetesRuntimeDeployment(
			deployment,
			expectedImageRef,
		);
		const desiredReplicas =
			deployment?.spec?.replicas ?? application.replicas ?? 1;
		return {
			provider: "kubernetes",
			imageRef:
				deployment?.spec?.template.spec?.containers[0]?.image?.toString() ??
				null,
			desiredReplicas,
			readyReplicas: deployment?.status?.readyReplicas ?? 0,
			state,
			message:
				deployment?.status?.conditions?.find(
					(condition) => condition.status === "False",
				)?.message ?? undefined,
		};
	};

	const waitUntilReady = async (
		application: RuntimeApplication,
		timeoutMs: number,
		expectedImageRef?: string,
	) => {
		const deadline = Date.now() + timeoutMs;
		let latest: RuntimeStatus | null = null;
		while (Date.now() < deadline) {
			latest = await getStatus(application, expectedImageRef);
			if (latest.state === "ready") return latest;
			if (latest.state === "failed") {
				throw new Error(latest.message || "Kubernetes rollout failed");
			}
			await sleep(pollIntervalMs);
		}
		throw new Error(
			`Kubernetes rollout did not become ready within ${timeoutMs}ms${latest?.message ? `: ${latest.message}` : ""}`,
		);
	};

	const scheduleImage = async (
		application: RuntimeApplication,
		imageRef: string,
		timeoutMs: number,
	) => {
		const environment = [
			...prepareEnvironmentVariables(
				application.env,
				application.environment.project.env,
				application.environment.env,
			),
			...(await managedDataEnvironmentForRuntimeApplication(application)),
		];
		const releaseIdentity =
			application.releaseIdentity || application.applicationId;
		const namespace = kubernetesReleaseNamespace({
			applicationId: application.applicationId,
			releaseIdentity: application.releaseIdentity,
			placementNamespace: placement.namespace,
		});
		const maxReplicas = positiveInteger(
			process.env.PLATFORM_KUBERNETES_MAX_REPLICAS,
			Math.max(application.replicas ?? 1, 3),
		);
		const networkGateway =
			clusterMetadata.gatewayNamespace && clusterMetadata.gatewayName
				? {
						namespace: clusterMetadata.gatewayNamespace,
						dataPlaneNamespace: clusterMetadata.gatewayDataPlaneNamespace,
						name: clusterMetadata.gatewayName,
						sectionName: clusterMetadata.gatewaySectionName,
						className: clusterMetadata.gatewayClassName,
						certIssuerName: clusterMetadata.certIssuerName,
						mode:
							clusterMetadata.gatewayMode === "dedicated"
								? "dedicated"
								: ("shared" as "shared" | "dedicated"),
						podSelector: clusterMetadata.gatewayPodSelector,
						externalDns: {
							enabled: clusterMetadata.externalDnsEnabled === true,
							target: clusterMetadata.externalDnsTarget,
							ttl: clusterMetadata.externalDnsTtl,
						},
					}
				: undefined;
		const registrySecretName =
			buildPool.registryAuthMode === "basic"
				? buildPool.runtimeRegistrySecretName ||
					clusterMetadata.registrySecretName
				: undefined;
		const registryCredentials =
			buildPool.registryAuthMode === "basic" &&
			buildPool.registryHost &&
			buildPool.registryUsername &&
			buildPool.registryPassword
				? {
						server: buildPool.registryHost,
						username: buildPool.registryUsername,
						password: buildPool.registryPassword,
					}
				: undefined;
		const observabilityNamespace =
			clusterMetadata.observabilityNamespace || "vlyv-observability";
		const observability = clusterMetadata.observabilityCollectorImage
			? {
					endpoint: `http://vlyv-otel-collector.${observabilityNamespace}.svc.cluster.local:4318`,
					namespace: observabilityNamespace,
					organizationId: observabilityTenantId(
						application.environment.project.organizationId,
					),
					applicationId: observabilityResourceId(
						"application",
						application.applicationId,
					),
					serviceName: application.appName,
				}
			: undefined;
		try {
			await client.apply(
				buildKubernetesRuntimeManifests({
					applicationId: releaseIdentity,
					billingApplicationId: application.applicationId,
					organizationId: application.environment.project.organizationId,
					appName: application.appName,
					namespace,
					imageRef,
					replicas: Math.max(application.replicas ?? 1, 1),
					maxReplicas,
					targetCpuUtilization: positiveInteger(
						process.env.PLATFORM_KUBERNETES_TARGET_CPU_PERCENT,
						70,
					),
					environment,
					ports: application.ports.map((port) => ({
						targetPort: port.targetPort,
						protocol: port.protocol === "udp" ? "udp" : "tcp",
					})),
					resources: resourcesFor(application),
					command: application.command
						? application.command.split(" ").filter(Boolean)
						: undefined,
					args: application.args,
					runtimeClassName:
						nodePool?.runtimeClassName || clusterMetadata.runtimeClassName,
					nodeSelector: nodePool?.labels,
					tolerations: nodePool?.taints,
					registrySecretName,
					registryCredentials,
					healthCheck: kubernetesHealthCheckForApplication(application),
					terminationGracePeriodSeconds: 30,
					multiZone: clusterMetadata.multiZoneEnabled === true,
					readOnlyRootFilesystem:
						clusterMetadata.readOnlyRootFilesystem === true,
					gateway: networkGateway,
					domains: [],
					allowedEgressCidrs: clusterMetadata.allowedEgressCidrs,
					observability,
				}),
			);
			const status = await waitUntilReady(application, timeoutMs, imageRef);
			await markPlatformPlacementReconciled(placement.placementId, "active", {
				imageRef,
				readyReplicas: status.readyReplicas,
			});
			return status;
		} catch (error) {
			await markPlatformPlacementReconciled(placement.placementId, "failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	};

	return {
		provider: "kubernetes",
		getCurrentImage: async (application) =>
			(await getStatus(application)).imageRef,
		schedule: async ({ application, artifact, timeoutMs = 180_000 }) => {
			assertVerifiedKubernetesArtifact(artifact);
			return scheduleImage(application, artifact.imageRef, timeoutMs);
		},
		verifyHealth: async ({ application, timeoutMs = 120_000 }) => {
			const startedAt = Date.now();
			await waitUntilReady(application, timeoutMs);
			const route =
				application.releaseDomains?.[0] ??
				(await verifiedRoutesForApplication(application.applicationId))[0];
			if (process.env.PLATFORM_HTTP_HEALTH_CHECK !== "true" || !route) {
				return {
					passed: true,
					latencyMs: Date.now() - startedAt,
					checkedAt: new Date().toISOString(),
				};
			}
			return verifyHttpEndpoint({
				endpoint: `https://${route.host}${route.path || "/"}`,
				timeoutMs,
				pollIntervalMs,
				fetcher,
				sleep,
			});
		},
		rollback: async ({ application, imageRef, timeoutMs = 180_000 }) =>
			scheduleImage(application, imageRef, timeoutMs),
		remove: async ({ application }) => {
			const releaseIdentity =
				application.releaseIdentity || application.applicationId;
			const namespace = kubernetesReleaseNamespace({
				applicationId: application.applicationId,
				releaseIdentity: application.releaseIdentity,
				placementNamespace: placement.namespace,
			});
			if (application.releaseIdentity) {
				await client.deleteNamespace(namespace);
				return;
			}
			const name = kubernetesApplicationResourceName(releaseIdentity);
			const registrySecretName =
				buildPool.registryAuthMode === "basic"
					? buildPool.runtimeRegistrySecretName ||
						clusterMetadata.registrySecretName
					: undefined;
			await Promise.all(
				[
					["gateway.networking.k8s.io/v1", "HTTPRoute", name],
					["autoscaling/v2", "HorizontalPodAutoscaler"],
					["policy/v1", "PodDisruptionBudget"],
					["apps/v1", "Deployment"],
					["v1", "Service"],
					["v1", "Secret"],
					["v1", "ServiceAccount"],
					...(registrySecretName ? [["v1", "Secret", registrySecretName]] : []),
				].map(([apiVersion, kind, resourceName]) =>
					client.delete({
						apiVersion,
						kind,
						metadata: {
							name: resourceName || (kind === "Secret" ? `${name}-env` : name),
							namespace,
						},
					}),
				),
			);
			if (
				clusterMetadata.gatewayNamespace &&
				(clusterMetadata.gatewayMode === "dedicated" ||
					clusterMetadata.gatewayMode === "hybrid" ||
					clusterMetadata.gatewayMode === undefined)
			) {
				await Promise.all([
					client.delete({
						apiVersion: "gateway.networking.k8s.io/v1",
						kind: "Gateway",
						metadata: {
							name: `${name}-gateway`,
							namespace: clusterMetadata.gatewayNamespace,
						},
					}),
					client.delete({
						apiVersion: "cert-manager.io/v1",
						kind: "Certificate",
						metadata: {
							name: `${name}-tls`,
							namespace: clusterMetadata.gatewayNamespace,
						},
					}),
				]);
			}
		},
	};
};
