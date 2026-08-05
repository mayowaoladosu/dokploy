import { db } from "@dokploy/server/db";
import { applications, platformPlacements } from "@dokploy/server/db/schema";
import type { V1Deployment } from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { kubernetesApplicationResourceName } from "./kubernetes/manifests";
import { reconcilePlatformDomainRoutes } from "./platform-runtime";

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
		where: eq(platformPlacements.runtime, "kubernetes"),
		with: {
			cluster: { with: { region: true } },
			application: { with: { ports: true } },
		},
	});
	const summary = { active: 0, pending: 0, failed: 0, skipped: 0 };
	for (const placement of placements) {
		if (
			placement.cluster.status !== "active" ||
			placement.cluster.region.status !== "active"
		) {
			summary.skipped += 1;
			continue;
		}
		try {
			const client = createKubernetesControlPlane({
				kubeconfig: placement.cluster.kubeconfig,
				inCluster: placement.cluster.metadata.inCluster,
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
