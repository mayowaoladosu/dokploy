import { db } from "@dokploy/server/db";
import { applications, platformPlacements } from "@dokploy/server/db/schema";
import type { V1Deployment } from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { kubernetesApplicationResourceName } from "./kubernetes/manifests";
import { reconcilePlatformDomainRoutes } from "./platform-runtime";
import { reconcileKubernetesRuntimeUsage } from "./runtime-usage-metering";

export const classifyKubernetesDeployment = (
	deployment: V1Deployment | null,
): "missing" | "pending" | "ready" | "failed" => {
	if (!deployment) return "missing";
	if (
		deployment.status?.conditions?.some(
			(condition) =>
				condition.type === "Progressing" &&
				condition.status === "False" &&
				condition.reason === "ProgressDeadlineExceeded",
		)
	) {
		return "failed";
	}
	const desired = deployment.spec?.replicas ?? 1;
	return (deployment.status?.readyReplicas ?? 0) >= desired
		? "ready"
		: "pending";
};

export const reconcileKubernetesPlacements = async () => {
	const placements = await db.query.platformPlacements.findMany({
		with: {
			runtimeTarget: { with: { cluster: { with: { region: true } } } },
			buildPool: true,
			application: {
				with: { ports: true, environment: { with: { project: true } } },
			},
		},
	});
	const summary = { active: 0, pending: 0, failed: 0, skipped: 0 };
	for (const placement of placements) {
		const { runtimeTarget, buildPool } = placement;
		const { cluster } = runtimeTarget;
		if (
			runtimeTarget.runtime !== "kubernetes" ||
			runtimeTarget.status !== "active" ||
			buildPool.status !== "active" ||
			cluster.status !== "active" ||
			cluster.region.status !== "active"
		) {
			summary.skipped += 1;
			continue;
		}
		try {
			const client = createKubernetesControlPlane({
				kubeconfig: cluster.kubeconfig,
				inCluster: cluster.metadata.inCluster,
			});
			const deployment = await client.readDeployment(
				placement.namespace,
				kubernetesApplicationResourceName(placement.applicationId),
			);
			const state = classifyKubernetesDeployment(deployment);
			const now = new Date();
			const placementStatus =
				placement.status === "draining" &&
				(deployment?.spec?.replicas ?? 0) === 0
					? "draining"
					: state === "ready"
						? "active"
						: state === "failed" ||
								(state === "missing" &&
									placement.application.applicationStatus === "done")
							? "failed"
							: "pending";
			await db
				.update(platformPlacements)
				.set({
					status: placementStatus,
					lastReconciledAt: now,
					updatedAt: now,
					metadata: {
						state,
						readyReplicas: deployment?.status?.readyReplicas ?? 0,
						imageRef:
							deployment?.spec?.template.spec?.containers[0]?.image ?? null,
					},
				})
				.where(eq(platformPlacements.placementId, placement.placementId));
			await reconcilePlatformDomainRoutes({
				applicationId: placement.applicationId,
				appName: placement.application.appName,
				port: placement.application.ports[0]?.targetPort ?? 3000,
			});
			if (cluster.metadata.metricsServerEnabled) {
				await reconcileKubernetesRuntimeUsage({
					client,
					placementId: placement.placementId,
					clusterId: cluster.clusterId,
					organizationId: placement.organizationId,
					projectId: placement.application.environment.project.projectId,
					environmentId: placement.application.environmentId,
					applicationId: placement.applicationId,
				}).catch((error) =>
					console.error(
						`Failed to meter Kubernetes runtime ${placement.placementId}`,
						error,
					),
				);
			}
			if (placementStatus === "failed") {
				await db
					.update(applications)
					.set({ applicationStatus: "error" })
					.where(eq(applications.applicationId, placement.applicationId));
				summary.failed += 1;
			} else if (placementStatus === "active") {
				summary.active += 1;
			} else {
				summary.pending += 1;
			}
		} catch (error) {
			await db
				.update(platformPlacements)
				.set({
					status: "failed",
					lastReconciledAt: new Date(),
					updatedAt: new Date(),
					metadata: {
						error: error instanceof Error ? error.message : String(error),
					},
				})
				.where(eq(platformPlacements.placementId, placement.placementId));
			summary.failed += 1;
		}
	}
	return summary;
};
