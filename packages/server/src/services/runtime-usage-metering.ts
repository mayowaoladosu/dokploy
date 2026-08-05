import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	runtimeUsageCheckpoints,
	usageEvents,
} from "@dokploy/server/db/schema";
import { eq, sql } from "drizzle-orm";
import type {
	KubernetesControlPlane,
	KubernetesPodMetric,
} from "./kubernetes/client";

const CPU_QUANTITY = /^(\d+)(?:\.(\d+))?(n|u|m)?$/;
const MEMORY_QUANTITY = /^(\d+)(?:\.(\d+))?(Ki|Mi|Gi|Ti|Pi|Ei|[kMGTPE])?$/;
const MAX_SAMPLE_INTERVAL_MS = 5 * 60_000;

const scaledDecimal = (
	whole: string,
	fraction: string | undefined,
	scale: bigint,
) => {
	const integer = BigInt(whole) * scale;
	if (!fraction) return integer;
	const normalized = fraction.slice(0, 18);
	return (
		integer + (BigInt(normalized) * scale) / 10n ** BigInt(normalized.length)
	);
};

export const kubernetesCpuNanocores = (value: string) => {
	const match = CPU_QUANTITY.exec(value.trim());
	if (!match) throw new Error("Kubernetes CPU metric is invalid");
	const [, whole = "0", fraction, suffix] = match;
	const scale =
		suffix === "n"
			? 1n
			: suffix === "u"
				? 1_000n
				: suffix === "m"
					? 1_000_000n
					: 1_000_000_000n;
	return scaledDecimal(whole, fraction, scale);
};

export const kubernetesMemoryBytes = (value: string) => {
	const match = MEMORY_QUANTITY.exec(value.trim());
	if (!match) throw new Error("Kubernetes memory metric is invalid");
	const [, whole = "0", fraction, suffix] = match;
	const binaryPowers: Record<string, bigint> = {
		Ki: 1_024n,
		Mi: 1_024n ** 2n,
		Gi: 1_024n ** 3n,
		Ti: 1_024n ** 4n,
		Pi: 1_024n ** 5n,
		Ei: 1_024n ** 6n,
	};
	const decimalPowers: Record<string, bigint> = {
		k: 1_000n,
		M: 1_000n ** 2n,
		G: 1_000n ** 3n,
		T: 1_000n ** 4n,
		P: 1_000n ** 5n,
		E: 1_000n ** 6n,
	};
	return scaledDecimal(
		whole,
		fraction,
		(suffix && (binaryPowers[suffix] || decimalPowers[suffix])) || 1n,
	);
};

const durationMilliseconds = (value: string | undefined) => {
	if (!value) return 60_000;
	const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
	if (!match) return 60_000;
	return Math.min(
		Math.max(Math.round(Number(match[1]) * 1_000), 1_000),
		MAX_SAMPLE_INTERVAL_MS,
	);
};

const aggregateMetrics = (metrics: KubernetesPodMetric[]) => {
	let cpuNanocores = 0n;
	let memoryBytes = 0n;
	let sampleAt = new Date(0);
	let initialWindowMs = 60_000;
	for (const pod of metrics) {
		const timestamp = new Date(pod.timestamp);
		if (!Number.isFinite(timestamp.getTime())) {
			throw new Error("Kubernetes metrics timestamp is invalid");
		}
		if (timestamp > sampleAt) sampleAt = timestamp;
		initialWindowMs = Math.min(
			initialWindowMs,
			durationMilliseconds(pod.window),
		);
		for (const container of pod.containers) {
			if (container.usage.cpu) {
				cpuNanocores += kubernetesCpuNanocores(container.usage.cpu);
			}
			if (container.usage.memory) {
				memoryBytes += kubernetesMemoryBytes(container.usage.memory);
			}
		}
	}
	return { cpuNanocores, memoryBytes, sampleAt, initialWindowMs };
};

const applicationMetricLabel = (applicationId: string) =>
	createHash("sha256").update(applicationId).digest("hex").slice(0, 16);

export const reconcileKubernetesRuntimeUsage = async ({
	client,
	placementId,
	clusterId,
	organizationId,
	projectId,
	environmentId,
	applicationId,
}: {
	client: KubernetesControlPlane;
	placementId: string;
	clusterId: string;
	organizationId: string;
	projectId: string;
	environmentId: string;
	applicationId: string;
}) => {
	const metrics = await client.listPodMetrics(
		null,
		`vlyv.dev/billing-application=${applicationMetricLabel(applicationId)},app.kubernetes.io/component=runtime`,
	);
	if (metrics.length === 0) return null;
	const aggregate = aggregateMetrics(metrics);
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`vlyv:runtime-usage:${placementId}`}, 0))`,
		);
		const checkpoint = await tx.query.runtimeUsageCheckpoints.findFirst({
			where: eq(runtimeUsageCheckpoints.placementId, placementId),
		});
		if (checkpoint && aggregate.sampleAt <= checkpoint.lastSampleAt)
			return null;
		const desiredStart =
			checkpoint?.lastMeteredAt ??
			new Date(aggregate.sampleAt.getTime() - aggregate.initialWindowMs);
		const periodStart = new Date(
			Math.max(
				desiredStart.getTime(),
				aggregate.sampleAt.getTime() - MAX_SAMPLE_INTERVAL_MS,
			),
		);
		const durationMs = aggregate.sampleAt.getTime() - periodStart.getTime();
		if (durationMs <= 0) return null;
		const cpuMilliseconds =
			(aggregate.cpuNanocores * BigInt(durationMs) + 999_999_999n) /
			1_000_000_000n;
		const memoryByteSeconds =
			(aggregate.memoryBytes * BigInt(durationMs) + 999n) / 1_000n;
		const sampleKey = aggregate.sampleAt.toISOString();
		await tx
			.insert(usageEvents)
			.values([
				{
					idempotencyKey: `${placementId}:${sampleKey}:cpu`,
					organizationId,
					projectId,
					environmentId,
					applicationId,
					metric: "cpu_milliseconds",
					source: "runtime",
					quantity: cpuMilliseconds,
					unit: "cpu_milliseconds",
					periodStart,
					periodEnd: aggregate.sampleAt,
					metadata: {
						placementId,
						clusterId,
						podCount: metrics.length,
					},
				},
				{
					idempotencyKey: `${placementId}:${sampleKey}:memory`,
					organizationId,
					projectId,
					environmentId,
					applicationId,
					metric: "memory_byte_seconds",
					source: "runtime",
					quantity: memoryByteSeconds,
					unit: "byte_seconds",
					periodStart,
					periodEnd: aggregate.sampleAt,
					metadata: {
						placementId,
						clusterId,
						podCount: metrics.length,
					},
				},
			])
			.onConflictDoNothing({ target: usageEvents.idempotencyKey });
		await tx
			.insert(runtimeUsageCheckpoints)
			.values({
				placementId,
				clusterId,
				lastMeteredAt: aggregate.sampleAt,
				lastSampleAt: aggregate.sampleAt,
				metadata: { podCount: metrics.length },
			})
			.onConflictDoUpdate({
				target: runtimeUsageCheckpoints.placementId,
				set: {
					clusterId,
					lastMeteredAt: aggregate.sampleAt,
					lastSampleAt: aggregate.sampleAt,
					metadata: { podCount: metrics.length },
					updatedAt: new Date(),
				},
			});
		return {
			periodStart,
			periodEnd: aggregate.sampleAt,
			cpuMilliseconds,
			memoryByteSeconds,
			podCount: metrics.length,
		};
	});
};
