import { db } from "@dokploy/server/db";
import {
	type UsageMetric,
	usageEvents,
	usageQuotas,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, sql } from "drizzle-orm";

export type UsageEventInput = {
	idempotencyKey: string;
	organizationId: string;
	projectId?: string | null;
	environmentId?: string | null;
	applicationId?: string | null;
	deploymentId?: string | null;
	metric: UsageMetric;
	source: "build" | "runtime" | "edge" | "storage" | "manual";
	quantity: bigint | number | string;
	unit: string;
	periodStart: Date;
	periodEnd: Date;
	costMicros?: bigint | number | string | null;
	metadata?: Record<string, unknown>;
};

const exactBigInt = (value: bigint | number | string, field: string) => {
	try {
		const parsed = BigInt(value);
		if (parsed < 0n) throw new Error();
		return parsed;
	} catch {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${field} must be a non-negative integer`,
		});
	}
};

export const recordUsageEvent = async (input: UsageEventInput) => {
	const [created] = await db
		.insert(usageEvents)
		.values({
			...input,
			quantity: exactBigInt(input.quantity, "quantity"),
			costMicros:
				input.costMicros === null || input.costMicros === undefined
					? null
					: exactBigInt(input.costMicros, "costMicros"),
			metadata: input.metadata ?? {},
		})
		.onConflictDoNothing({ target: usageEvents.idempotencyKey })
		.returning();
	if (created) return created;
	const existing = await db.query.usageEvents.findFirst({
		where: eq(usageEvents.idempotencyKey, input.idempotencyKey),
	});
	if (!existing) throw new Error("Failed to persist idempotent usage event");
	return existing;
};

export const usageWindowStart = (
	window: "hour" | "day" | "month",
	now = new Date(),
) => {
	const start = new Date(now);
	start.setUTCMinutes(0, 0, 0);
	if (window === "day" || window === "month") start.setUTCHours(0);
	if (window === "month") start.setUTCDate(1);
	return start;
};

export const getUsageTotal = async ({
	organizationId,
	metric,
	from,
}: {
	organizationId: string;
	metric: UsageMetric;
	from: Date;
}) => {
	const [result] = await db
		.select({
			total: sql<string>`coalesce(sum(${usageEvents.quantity}), 0)::text`,
		})
		.from(usageEvents)
		.where(
			and(
				eq(usageEvents.organizationId, organizationId),
				eq(usageEvents.metric, metric),
				gte(usageEvents.periodStart, from),
			),
		);
	return BigInt(result?.total ?? "0");
};

export const assertUsageWithinQuota = async (
	organizationId: string,
	metric: UsageMetric,
	now = new Date(),
) => {
	const quotas = await db.query.usageQuotas.findMany({
		where: and(
			eq(usageQuotas.organizationId, organizationId),
			eq(usageQuotas.metric, metric),
			eq(usageQuotas.enabled, true),
		),
	});
	for (const quota of quotas) {
		const used = await getUsageTotal({
			organizationId,
			metric,
			from: usageWindowStart(quota.window, now),
		});
		if (used < quota.limitQuantity) continue;
		if (quota.action === "warn") {
			console.warn(
				`Usage quota warning: organization ${organizationId} exceeded ${metric} ${quota.window} limit`,
			);
			continue;
		}
		throw new TRPCError({
			code: quota.action === "throttle" ? "TOO_MANY_REQUESTS" : "FORBIDDEN",
			message: `${metric} quota exceeded for the current ${quota.window}`,
		});
	}
};

export const upsertUsageQuota = async (input: {
	organizationId: string;
	metric: UsageMetric;
	window: "hour" | "day" | "month";
	limitQuantity: bigint | number | string;
	action?: "warn" | "block" | "throttle";
	enabled?: boolean;
	metadata?: Record<string, unknown>;
}) => {
	const [quota] = await db
		.insert(usageQuotas)
		.values({
			...input,
			limitQuantity: exactBigInt(input.limitQuantity, "limitQuantity"),
		})
		.onConflictDoUpdate({
			target: [
				usageQuotas.organizationId,
				usageQuotas.metric,
				usageQuotas.window,
			],
			set: {
				limitQuantity: exactBigInt(input.limitQuantity, "limitQuantity"),
				action: input.action ?? "block",
				enabled: input.enabled ?? true,
				metadata: input.metadata ?? {},
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!quota) throw new Error("Failed to persist usage quota");
	return quota;
};

export interface UsageMeter {
	assertBuildAllowed(organizationId: string): Promise<void>;
	recordBuild(input: {
		organizationId: string;
		projectId: string;
		environmentId: string;
		applicationId: string;
		deploymentId: string;
		durationMs: number;
		imageSizeBytes: number | null;
	}): Promise<void>;
}

export const createUsageMeter = (): UsageMeter => ({
	assertBuildAllowed: async (organizationId) =>
		assertUsageWithinQuota(organizationId, "build_seconds"),
	recordBuild: async (input) => {
		const observedAt = new Date();
		await recordUsageEvent({
			idempotencyKey: `${input.deploymentId}:build-seconds`,
			organizationId: input.organizationId,
			projectId: input.projectId,
			environmentId: input.environmentId,
			applicationId: input.applicationId,
			deploymentId: input.deploymentId,
			metric: "build_seconds",
			source: "build",
			quantity: BigInt(Math.max(Math.ceil(input.durationMs / 1000), 1)),
			unit: "seconds",
			periodStart: new Date(observedAt.getTime() - input.durationMs),
			periodEnd: observedAt,
			metadata: { durationMs: input.durationMs },
		});
		if (input.imageSizeBytes !== null) {
			await recordUsageEvent({
				idempotencyKey: `${input.deploymentId}:artifact-bytes`,
				organizationId: input.organizationId,
				projectId: input.projectId,
				environmentId: input.environmentId,
				applicationId: input.applicationId,
				deploymentId: input.deploymentId,
				metric: "storage_byte_hours",
				source: "storage",
				quantity: BigInt(Math.max(input.imageSizeBytes, 0)),
				unit: "byte_hours",
				periodStart: observedAt,
				periodEnd: new Date(observedAt.getTime() + 60 * 60 * 1000),
				metadata: { initialArtifactBytes: input.imageSizeBytes },
			});
		}
	},
});
