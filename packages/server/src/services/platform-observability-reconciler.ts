import { db } from "@dokploy/server/db";
import { platformObservabilityBackends } from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { buildKubernetesObservabilityCollectorManifests } from "./kubernetes/observability-manifests";

const waitForObservabilityReadiness = async ({
	client,
	namespace,
	requireLogAgent,
	timeoutMs = 120_000,
	pollMs = 2_000,
}: {
	client: ReturnType<typeof createKubernetesControlPlane>;
	namespace: string;
	requireLogAgent: boolean;
	timeoutMs?: number;
	pollMs?: number;
}) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const collector = await client.read({
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name: "vlyv-otel-collector", namespace },
		});
		const collectorStatus = collector as unknown as {
			metadata?: { generation?: number };
			spec?: { replicas?: number };
			status?: {
				availableReplicas?: number;
				updatedReplicas?: number;
				observedGeneration?: number;
			};
		} | null;
		const desiredCollectorReplicas = collectorStatus?.spec?.replicas ?? 2;
		const collectorReady =
			(collectorStatus?.status?.observedGeneration ?? 0) >=
				(collectorStatus?.metadata?.generation ?? 1) &&
			(collectorStatus?.status?.availableReplicas ?? 0) >=
				desiredCollectorReplicas &&
			(collectorStatus?.status?.updatedReplicas ?? 0) >=
				desiredCollectorReplicas;
		let logReady = !requireLogAgent;
		if (requireLogAgent) {
			const logAgent = await client.read({
				apiVersion: "apps/v1",
				kind: "DaemonSet",
				metadata: { name: "vlyv-otel-log-agent", namespace },
			});
			const logStatus = logAgent as unknown as {
				metadata?: { generation?: number };
				status?: {
					desiredNumberScheduled?: number;
					numberReady?: number;
					updatedNumberScheduled?: number;
					observedGeneration?: number;
				};
			} | null;
			logReady =
				(logStatus?.status?.observedGeneration ?? 0) >=
					(logStatus?.metadata?.generation ?? 1) &&
				(logStatus?.status?.desiredNumberScheduled ?? 0) >= 1 &&
				(logStatus?.status?.numberReady ?? 0) >=
					(logStatus?.status?.desiredNumberScheduled ?? 0) &&
				(logStatus?.status?.updatedNumberScheduled ?? 0) >=
					(logStatus?.status?.desiredNumberScheduled ?? 0);
		}
		if (collectorReady && logReady) return;
		await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
	}
	throw new Error(
		"Observability workloads did not become ready before timeout",
	);
};

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
	const otlp = backends.find((backend) => backend.kind === "otlp");
	const summary = { active: 0, failed: 0, skipped: 0 };
	for (const cluster of clusters) {
		const image = cluster.metadata.observabilityCollectorImage;
		if (!image || (!otlp && !metrics && !logs && !traces)) {
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
			const namespace =
				cluster.metadata.observabilityNamespace || "vlyv-observability";
			await client.apply(
				buildKubernetesObservabilityCollectorManifests({
					namespace: namespace,
					image,
					otlp: otlp
						? {
								endpoint: otlp.endpoint,
								headers: {
									...(otlp.metadata.otlpHeaders ?? {}),
									...(otlp.authToken
										? {
												Authorization: `${otlp.metadata.authScheme || "Bearer"} ${otlp.authToken}`,
											}
										: {}),
								},
							}
						: null,
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
			await waitForObservabilityReadiness({
				client,
				namespace,
				requireLogAgent: Boolean(logs || otlp),
			});
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
