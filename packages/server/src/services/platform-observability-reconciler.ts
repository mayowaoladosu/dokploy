import { db } from "@dokploy/server/db";
import { platformObservabilityBackends } from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { buildKubernetesObservabilityCollectorManifests } from "./kubernetes/observability-manifests";

export const reconcilePlatformObservabilityCollectors = async () => {
	const [clusters, backends] = await Promise.all([
		db.query.platformClusters.findMany({
			where: (table, { and, eq }) =>
				and(eq(table.runtime, "kubernetes"), eq(table.status, "active")),
			with: { nodePools: true },
		}),
		db.query.platformObservabilityBackends.findMany({
			where: and(
				eq(platformObservabilityBackends.status, "active"),
				eq(platformObservabilityBackends.isDefault, true),
			),
		}),
	]);
	const metrics = backends.find((backend) => backend.kind === "prometheus");
	const logs = backends.find(
		(backend) => backend.kind === "loki" || backend.kind === "clickhouse",
	);
	const traces = backends.find((backend) => backend.kind === "tempo");
	const summary = { active: 0, failed: 0, skipped: 0 };
	for (const cluster of clusters) {
		const image = cluster.metadata.observabilityCollectorImage;
		if (!image || (!metrics && !logs && !traces)) {
			summary.skipped += 1;
			continue;
		}
		try {
			const systemPool = cluster.nodePools.find(
				(pool) => pool.purpose === "system" && pool.status === "active",
			);
			const client = createKubernetesControlPlane({
				kubeconfig: cluster.kubeconfig,
				inCluster: cluster.metadata.inCluster,
			});
			await client.apply(
				buildKubernetesObservabilityCollectorManifests({
					namespace:
						cluster.metadata.observabilityNamespace || "vlyv-observability",
					image,
					metrics: metrics
						? {
								endpoint: metrics.endpoint,
								authToken: metrics.authToken,
								tenantHeader: metrics.tenantHeader,
								tenantId: metrics.tenantId,
							}
						: null,
					logs: logs
						? {
								endpoint: logs.endpoint,
								authToken: logs.authToken,
								tenantHeader: logs.tenantHeader,
								tenantId: logs.tenantId,
							}
						: null,
					traces: traces
						? {
								endpoint: traces.endpoint,
								authToken: traces.authToken,
								tenantHeader: traces.tenantHeader,
								tenantId: traces.tenantId,
							}
						: null,
					nodeSelector: systemPool?.labels,
					tolerations: systemPool?.taints,
				}),
			);
			summary.active += 1;
		} catch (error) {
			summary.failed += 1;
			console.error(
				`Failed to reconcile observability collector for cluster ${cluster.clusterId}`,
				error,
			);
		}
	}
	return summary;
};
