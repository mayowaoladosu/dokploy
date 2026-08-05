import { db } from "@dokploy/server/db";
import { platformNodePools } from "@dokploy/server/db/schema";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import type { RegistryCredentialMode } from "@dokploy/server/utils/cluster/upload";
import { and, asc, eq } from "drizzle-orm";
import { createKubernetesBuildExecutor } from "./kubernetes/build-executor";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { createKubernetesRuntimeScheduler } from "./kubernetes/runtime-scheduler";
import { findApplicationPlatformPlacement } from "./platform-infrastructure";
import { createReleaseOrchestrator } from "./release-orchestrator";

export type PlatformReleasePlan = {
	orchestrator: ReturnType<typeof createReleaseOrchestrator>;
	registryCredentialMode: RegistryCredentialMode;
};

export const createPlatformReleasePlan = async (
	application: ApplicationNested,
): Promise<PlatformReleasePlan> => {
	const placement = await findApplicationPlatformPlacement(
		application.applicationId,
	);
	if (!placement || placement.runtime !== "kubernetes") {
		return {
			orchestrator: createReleaseOrchestrator(),
			registryCredentialMode: "inline",
		};
	}
	if (
		placement.cluster.runtime !== "kubernetes" ||
		placement.cluster.status !== "active" ||
		placement.cluster.region.status !== "active"
	) {
		throw new Error("The assigned Kubernetes placement is not active");
	}

	const client = createKubernetesControlPlane({
		kubeconfig: placement.cluster.kubeconfig,
		inCluster: placement.cluster.metadata.inCluster,
	});
	const buildNodePool =
		(await db.query.platformNodePools.findFirst({
			where: and(
				eq(platformNodePools.clusterId, placement.clusterId),
				eq(platformNodePools.purpose, "build"),
				eq(platformNodePools.status, "active"),
			),
			orderBy: [asc(platformNodePools.name)],
		})) ?? null;

	return {
		orchestrator: createReleaseOrchestrator({
			buildExecutor: createKubernetesBuildExecutor({
				client,
				placement,
				clusterMetadata: placement.cluster.metadata,
				nodePool: buildNodePool,
			}),
			runtimeScheduler: createKubernetesRuntimeScheduler({
				client,
				placement,
				clusterMetadata: placement.cluster.metadata,
				nodePool: placement.nodePool,
			}),
		}),
		registryCredentialMode: "environment",
	};
};

export const createPlatformReleaseOrchestrator = async (
	application: ApplicationNested,
) => (await createPlatformReleasePlan(application)).orchestrator;
