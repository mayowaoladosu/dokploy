import type {
	PlatformClusterMetadata,
	PlatformNodePool,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { prepareEnvironmentVariables } from "@dokploy/server/utils/docker/utils";
import { findVerifiedDomainsByApplicationId } from "../domain-verification";
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
	type KubernetesResourceSpec,
	kubernetesApplicationResourceName,
} from "./manifests";

type KubernetesRuntimeSchedulerInput = {
	client: KubernetesControlPlane;
	placement: PlatformPlacement;
	clusterMetadata: PlatformClusterMetadata;
	nodePool: PlatformNodePool | null;
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

const runtimeState = (
	deployment: Awaited<ReturnType<KubernetesControlPlane["readDeployment"]>>,
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
	return (deployment.status?.readyReplicas ?? 0) >= desired
		? "ready"
		: "pending";
};

export const createKubernetesRuntimeScheduler = ({
	client,
	placement,
	clusterMetadata,
	nodePool,
	pollIntervalMs = 2_000,
	sleep = defaultSleep,
	fetcher = fetch,
}: KubernetesRuntimeSchedulerInput): RuntimeScheduler => {
	const getStatus = async (
		application: RuntimeApplication,
	): Promise<RuntimeStatus> => {
		const deployment = await client.readDeployment(
			placement.namespace,
			kubernetesApplicationResourceName(application.applicationId),
		);
		const state = runtimeState(deployment);
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
	) => {
		const deadline = Date.now() + timeoutMs;
		let latest: RuntimeStatus | null = null;
		while (Date.now() < deadline) {
			latest = await getStatus(application);
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
		const environment = prepareEnvironmentVariables(
			application.env,
			application.environment.project.env,
			application.environment.env,
		);
		const routes = await verifiedRoutesForApplication(
			application.applicationId,
		);
		const maxReplicas = positiveInteger(
			process.env.PLATFORM_KUBERNETES_MAX_REPLICAS,
			Math.max(application.replicas ?? 1, 3),
		);
		const gateway =
			clusterMetadata.gatewayNamespace && clusterMetadata.gatewayName
				? {
						namespace: clusterMetadata.gatewayNamespace,
						name: clusterMetadata.gatewayName,
						sectionName: clusterMetadata.gatewaySectionName,
						className: clusterMetadata.gatewayClassName,
						certIssuerName: clusterMetadata.certIssuerName,
					}
				: undefined;
		try {
			await client.apply(
				buildKubernetesRuntimeManifests({
					applicationId: application.applicationId,
					organizationId: application.environment.project.organizationId,
					appName: application.appName,
					namespace: placement.namespace,
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
					registrySecretName: clusterMetadata.registrySecretName,
					gateway,
					domains: routes,
					allowedEgressCidrs: clusterMetadata.allowedEgressCidrs,
				}),
			);
			const status = await waitUntilReady(application, timeoutMs);
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
		schedule: async ({ application, artifact, timeoutMs = 180_000 }) =>
			scheduleImage(application, artifact.imageRef, timeoutMs),
		verifyHealth: async ({ application, timeoutMs = 120_000 }) => {
			const startedAt = Date.now();
			await waitUntilReady(application, timeoutMs);
			const route = (
				await verifiedRoutesForApplication(application.applicationId)
			)[0];
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
	};
};
