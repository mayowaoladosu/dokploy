import { db } from "@dokploy/server/db";
import {
	applications,
	platformPlacements,
	previewDeployments,
} from "@dokploy/server/db/schema";
import type { V1Deployment } from "@kubernetes/client-node";
import { eq } from "drizzle-orm";
import { createKubernetesControlPlane } from "./kubernetes/client";
import {
	buildKubernetesHpaManifest,
	kubernetesApplicationResourceName,
	kubernetesReleaseNamespace,
} from "./kubernetes/manifests";
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

export const reconcileManagedBillingSuspensions = async () => {
	const placements = await db.query.platformPlacements.findMany({
		with: {
			runtimeTarget: { with: { cluster: true } },
			application: true,
			organization: { with: { owner: true } },
		},
	});
	const summary = { suspended: 0, resumed: 0, unchanged: 0, failed: 0 };
	for (const placement of placements) {
		try {
			const isEntitled = Boolean(
				placement.organization.owner.isEnterpriseCloud ||
					((placement.organization.billingStatus === "active" ||
						placement.organization.billingStatus === "trialing") &&
						placement.organization.billingLastSyncedAt &&
						Date.now() - placement.organization.billingLastSyncedAt.getTime() <=
							24 * 60 * 60 * 1_000 &&
						(placement.organization.billingCurrentPeriodEnd === null ||
							placement.organization.billingCurrentPeriodEnd.getTime() >=
								Date.now())),
			);
			const cluster = placement.runtimeTarget.cluster;
			const client = createKubernetesControlPlane({
				kubeconfig: cluster.kubeconfig,
				inCluster: cluster.metadata.inCluster,
			});
			const name = kubernetesApplicationResourceName(placement.applicationId);
			const deployment = await client.readDeployment(placement.namespace, name);
			const replicas = deployment?.spec?.replicas ?? 0;
			if (
				isEntitled &&
				placement.metadata.billingSuspended === true &&
				!deployment
			) {
				throw new Error(
					"Billing-suspended production workload is missing and requires redeployment",
				);
			}
			if (
				!isEntitled &&
				deployment &&
				placement.metadata.billingSuspended !== true
			) {
				await client.delete({
					apiVersion: "autoscaling/v2",
					kind: "HorizontalPodAutoscaler",
					metadata: { name, namespace: placement.namespace },
				});
				if (replicas > 0) {
					await client.setDeploymentReplicas(placement.namespace, name, 0);
				}
				await db
					.update(platformPlacements)
					.set({
						status: "draining",
						metadata: { ...placement.metadata, billingSuspended: true },
						updatedAt: new Date(),
					})
					.where(eq(platformPlacements.placementId, placement.placementId));
				summary.suspended += 1;
			} else if (
				isEntitled &&
				deployment &&
				replicas === 0 &&
				placement.status === "draining" &&
				placement.metadata.billingSuspended === true &&
				placement.application.applicationStatus === "done"
			) {
				await client.setDeploymentReplicas(
					placement.namespace,
					name,
					Math.max(placement.desiredReplicas, 1),
				);
				await client.apply([
					buildKubernetesHpaManifest({
						applicationId: placement.applicationId,
						organizationId: placement.organizationId,
						appName: placement.application.appName,
						namespace: placement.namespace,
						minReplicas: Math.max(placement.desiredReplicas, 1),
						maxReplicas: Math.max(
							Number.parseInt(
								process.env.PLATFORM_KUBERNETES_MAX_REPLICAS || "3",
								10,
							),
							placement.desiredReplicas,
						),
						targetCpuUtilization: Number.parseInt(
							process.env.PLATFORM_KUBERNETES_TARGET_CPU_PERCENT || "70",
							10,
						),
					}),
				]);
				await db
					.update(platformPlacements)
					.set({
						status: "pending",
						metadata: { ...placement.metadata, billingSuspended: false },
						updatedAt: new Date(),
					})
					.where(eq(platformPlacements.placementId, placement.placementId));
				summary.resumed += 1;
			} else {
				summary.unchanged += 1;
			}
			const previews = await db.query.previewDeployments.findMany({
				where: (table, { eq }) =>
					eq(table.applicationId, placement.applicationId),
			});
			if (!isEntitled) {
				for (const preview of previews) {
					const previewNamespace = kubernetesReleaseNamespace({
						applicationId: placement.applicationId,
						releaseIdentity: preview.previewDeploymentId,
						placementNamespace: placement.namespace,
					});
					const previewName = kubernetesApplicationResourceName(
						preview.previewDeploymentId,
					);
					await client.delete({
						apiVersion: "autoscaling/v2",
						kind: "HorizontalPodAutoscaler",
						metadata: { name: previewName, namespace: previewNamespace },
					});
					const previewDeployment = await client.readDeployment(
						previewNamespace,
						previewName,
					);
					if ((previewDeployment?.spec?.replicas ?? 0) > 0) {
						await client.setDeploymentReplicas(
							previewNamespace,
							previewName,
							0,
						);
					}
					if (previewDeployment && preview.billingSuspended !== true) {
						await db
							.update(previewDeployments)
							.set({
								billingSuspended: true,
								billingSuspendedReplicas: Math.max(
									previewDeployment.spec?.replicas ?? 1,
									1,
								),
							})
							.where(
								eq(
									previewDeployments.previewDeploymentId,
									preview.previewDeploymentId,
								),
							);
					}
				}
			} else {
				for (const preview of previews) {
					if (preview.billingSuspended !== true) continue;
					const previewNamespace = kubernetesReleaseNamespace({
						applicationId: placement.applicationId,
						releaseIdentity: preview.previewDeploymentId,
						placementNamespace: placement.namespace,
					});
					const previewName = kubernetesApplicationResourceName(
						preview.previewDeploymentId,
					);
					const previewDeployment = await client.readDeployment(
						previewNamespace,
						previewName,
					);
					if (!previewDeployment) {
						throw new Error(
							`Billing-suspended preview ${preview.previewDeploymentId} is missing and requires redeployment`,
						);
					}
					if ((previewDeployment.spec?.replicas ?? 0) === 0) {
						const desiredReplicas = Math.max(
							preview.billingSuspendedReplicas ?? 1,
							1,
						);
						await client.setDeploymentReplicas(
							previewNamespace,
							previewName,
							desiredReplicas,
						);
						await client.apply([
							buildKubernetesHpaManifest({
								applicationId: preview.previewDeploymentId,
								organizationId: placement.organizationId,
								appName: preview.appName,
								namespace: previewNamespace,
								minReplicas: desiredReplicas,
								maxReplicas: Math.max(
									Number.parseInt(
										process.env.PLATFORM_KUBERNETES_MAX_REPLICAS || "3",
										10,
									),
									desiredReplicas,
								),
								targetCpuUtilization: Number.parseInt(
									process.env.PLATFORM_KUBERNETES_TARGET_CPU_PERCENT || "70",
									10,
								),
							}),
						]);
						await db
							.update(previewDeployments)
							.set({
								billingSuspended: false,
								billingSuspendedReplicas: null,
							})
							.where(
								eq(
									previewDeployments.previewDeploymentId,
									preview.previewDeploymentId,
								),
							);
					}
				}
			}
		} catch (error) {
			summary.failed += 1;
			console.error(
				`Failed to reconcile billing suspension for placement ${placement.placementId}`,
				error,
			);
		}
	}
	return summary;
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
						...placement.metadata,
						state,
						readyReplicas: deployment?.status?.readyReplicas ?? 0,
						imageRef:
							deployment?.spec?.template.spec?.containers[0]?.image ?? null,
					},
				})
				.where(eq(platformPlacements.placementId, placement.placementId));
			if (placement.metadata.billingSuspended !== true) {
				await reconcilePlatformDomainRoutes({
					applicationId: placement.applicationId,
					appName: placement.application.appName,
					port: placement.application.ports[0]?.targetPort ?? 3000,
				});
			}
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
						...placement.metadata,
						error: error instanceof Error ? error.message : String(error),
					},
				})
				.where(eq(platformPlacements.placementId, placement.placementId));
			summary.failed += 1;
		}
	}
	return summary;
};
