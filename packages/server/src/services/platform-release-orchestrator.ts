import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { createKubernetesEdgeRouter } from "./edge-router";
import { createKubernetesBuildExecutor } from "./kubernetes/build-executor";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { createKubernetesRuntimeScheduler } from "./kubernetes/runtime-scheduler";
import {
	createCloudflarePlatformEdgeRouter,
	findDefaultPlatformEdgeProvider,
} from "./platform-edge";
import { findApplicationPlatformPlacement } from "./platform-infrastructure";
import { createReleaseOrchestrator } from "./release-orchestrator";
import { createApplicationSourcePreparer } from "./source-preparer";

export type PlatformReleasePlan = {
	orchestrator: ReturnType<typeof createReleaseOrchestrator>;
};

export const createPlatformReleasePlan = async (
	application: ApplicationNested,
): Promise<PlatformReleasePlan> => {
	const placement = await findApplicationPlatformPlacement(
		application.applicationId,
	);
	if (!placement) {
		if (IS_MANAGED_PAAS) {
			throw new Error("Managed application has no platform placement");
		}
		return {
			orchestrator: createReleaseOrchestrator(),
		};
	}
	const { runtimeTarget, buildPool } = placement;
	const { cluster } = runtimeTarget;
	if (
		runtimeTarget.runtime !== "kubernetes" ||
		runtimeTarget.status !== "active" ||
		buildPool.runtime !== "kubernetes" ||
		buildPool.status !== "active" ||
		cluster.runtime !== "kubernetes" ||
		cluster.status !== "active" ||
		cluster.region.status !== "active"
	) {
		throw new Error("The assigned Kubernetes placement is not active");
	}

	const client = createKubernetesControlPlane({
		kubeconfig: cluster.kubeconfig,
		inCluster: cluster.metadata.inCluster,
	});
	const runtimeMetadata = {
		...cluster.metadata,
		registrySecretName:
			buildPool.runtimeRegistrySecretName ||
			cluster.metadata.registrySecretName,
	};
	const edgeProvider = await findDefaultPlatformEdgeProvider();
	if (IS_MANAGED_PAAS && !edgeProvider) {
		throw new Error(
			"Managed releases require an active platform edge provider",
		);
	}
	const originRouter = createKubernetesEdgeRouter({
		client,
		placement,
		clusterMetadata: edgeProvider
			? { ...cluster.metadata, externalDnsEnabled: false }
			: cluster.metadata,
		originProtection:
			edgeProvider?.metadata.originLockdownEnabled === true &&
			edgeProvider.originTokenHash
				? {
						headerName: "x-vlyv-origin-token",
						headerValue: edgeProvider.originTokenHash,
					}
				: undefined,
	});

	return {
		orchestrator: createReleaseOrchestrator({
			sourcePreparer: createApplicationSourcePreparer({
				registryCredentialMode: "environment",
				uploadApplicationRegistries: false,
				buildEnvironmentMode: "environment",
			}),
			buildExecutor: createKubernetesBuildExecutor({
				client,
				placement,
				clusterMetadata: cluster.metadata,
				buildPool,
				nodePool: buildPool.nodePool,
			}),
			runtimeScheduler: createKubernetesRuntimeScheduler({
				client,
				placement,
				clusterMetadata: runtimeMetadata,
				nodePool: runtimeTarget.nodePool,
				buildPool,
			}),
			edgeRouter: edgeProvider
				? createCloudflarePlatformEdgeRouter({
						originRouter,
						provider: edgeProvider,
					})
				: originRouter,
		}),
	};
};

export const createPlatformReleaseOrchestrator = async (
	application: ApplicationNested,
) => (await createPlatformReleasePlan(application)).orchestrator;
