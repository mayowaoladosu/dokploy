import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	managedDataResources,
	managedDataUsageCheckpoints,
} from "@dokploy/server/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { getManagedDataProvider } from "./managed-data-provider";
import { recordDatabaseUsage } from "./usage-metering";

const MAX_BACKFILL_MS = 60 * 60 * 1_000;

export const managedDataUsagePeriod = (
	lastMeteredAt: Date | null,
	observedAt: Date,
) => {
	if (!Number.isFinite(observedAt.getTime())) {
		throw new Error("Managed data provider usage timestamp is invalid");
	}
	const periodStart = new Date(
		Math.max(
			lastMeteredAt?.getTime() ?? observedAt.getTime() - MAX_BACKFILL_MS,
			observedAt.getTime() - MAX_BACKFILL_MS,
		),
	);
	return observedAt > periodStart
		? { periodStart, periodEnd: observedAt }
		: null;
};

export const reconcileManagedDataUsage = async (
	now = new Date(),
	maxResources = 100,
) => {
	if (
		!Number.isSafeInteger(maxResources) ||
		maxResources < 1 ||
		maxResources > 1_000
	) {
		throw new Error("Managed data usage reconciliation limit is invalid");
	}
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended('vlyv:managed-data-usage', 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		return { reconciled: 0, failed: 0 };
	}
	try {
		const resources = await db.query.managedDataResources.findMany({
			where: and(
				eq(managedDataResources.status, "ready"),
				sql`${managedDataResources.providerResourceId} is not null`,
			),
			orderBy: [asc(managedDataResources.updatedAt)],
			limit: maxResources,
		});
		let reconciled = 0;
		let failed = 0;
		for (const resource of resources) {
			try {
				const provider = getManagedDataProvider(resource.provider);
				const usage = await provider.getUsage(resource.providerResourceId!);
				if (
					usage.observedAt > now ||
					!Number.isFinite(usage.observedAt.getTime())
				) {
					throw new Error("Managed data provider usage timestamp is invalid");
				}
				await db.transaction(async (tx) => {
					await tx.execute(
						sql`select pg_advisory_xact_lock(hashtextextended(${`vlyv:managed-data-usage:${resource.managedDataResourceId}`}, 0))`,
					);
					const checkpoint =
						await tx.query.managedDataUsageCheckpoints.findFirst({
							where: eq(
								managedDataUsageCheckpoints.managedDataResourceId,
								resource.managedDataResourceId,
							),
						});
					if (checkpoint && usage.observedAt <= checkpoint.lastSampleAt) return;
					const period = managedDataUsagePeriod(
						checkpoint?.lastMeteredAt ?? null,
						usage.observedAt,
					);
					if (!period) return;
					await recordDatabaseUsage({
						managedDataResourceId: resource.managedDataResourceId,
						organizationId: resource.organizationId,
						projectId: resource.projectId,
						environmentId: resource.environmentId,
						consumedBytes: usage.consumedBytes,
						periodStart: period.periodStart,
						periodEnd: period.periodEnd,
						provider: resource.provider,
					});
					await tx
						.insert(managedDataUsageCheckpoints)
						.values({
							managedDataResourceId: resource.managedDataResourceId,
							lastMeteredAt: usage.observedAt,
							lastSampleAt: usage.observedAt,
							metadata: {
								consumedBytes: usage.consumedBytes.toString(),
								provider: resource.provider,
							},
						})
						.onConflictDoUpdate({
							target: managedDataUsageCheckpoints.managedDataResourceId,
							set: {
								lastMeteredAt: usage.observedAt,
								lastSampleAt: usage.observedAt,
								metadata: {
									consumedBytes: usage.consumedBytes.toString(),
									provider: resource.provider,
								},
								updatedAt: new Date(),
							},
						});
				});
				reconciled += 1;
			} catch (error) {
				failed += 1;
				console.error(
					`Failed to reconcile managed data usage for ${resource.managedDataResourceId}`,
					error,
				);
			}
		}
		return { reconciled, failed };
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended('vlyv:managed-data-usage', 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};
