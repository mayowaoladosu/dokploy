import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import type { RegistryCredentialMode } from "@dokploy/server/utils/cluster/upload";
import { createKubernetesBuildExecutor } from "./kubernetes/build-executor";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { createKubernetesRuntimeScheduler } from "./kubernetes/runtime-scheduler";
import { findApplicationPlatformPlacement } from "./platform-infrastructure";
import { createReleaseOrchestrator } from "./release-orchestrator";

export type PlatformReleasePlan = {
	orchestrator: ReturnType<typeof createReleaseOrchestrator>;
	registryCredentialMode: RegistryCredentialMode;
	usesPlatformRegistry: boolean;
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
			registryCredentialMode: "inline",
			usesPlatformRegistry: false,
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

	return {
		orchestrator: createReleaseOrchestrator({
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
			}),
		}),
		registryCredentialMode: "environment",
		usesPlatformRegistry: true,
	};
};

export const createPlatformReleaseOrchestrator = async (
	application: ApplicationNested,
) => (await createPlatformReleasePlan(application)).orchestrator;
