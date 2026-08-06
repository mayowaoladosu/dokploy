import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	managedDataResources,
	managedDataUsageCheckpoints,
	usageEvents,
} from "@dokploy/server/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { getManagedDataProvider } from "./managed-data-provider";
import { databaseByteSeconds } from "./usage-metering";

const MAX_BACKFILL_MS = 60 * 60 * 1_000;

export const managedDataUsagePeriod = (
	lastMeteredAt: Date | null,
	observedAt: Date,
	resourceCreatedAt?: Date,
) => {
	if (!Number.isFinite(observedAt.getTime())) {
		throw new Error("Managed data provider usage timestamp is invalid");
	}
	const periodStart = new Date(
		lastMeteredAt?.getTime() ??
			Math.max(
				resourceCreatedAt?.getTime() ?? observedAt.getTime() - MAX_BACKFILL_MS,
				observedAt.getTime() - MAX_BACKFILL_MS,
			),
	);
	return observedAt > periodStart
		? { periodStart, periodEnd: observedAt }
		: null;
};

export const averageDatabaseBytes = (
	previous: bigint | null,
	current: bigint,
) => (previous === null ? current : (previous + current) / 2n);

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
		const resources = await db
			.select({
				resource: managedDataResources,
				checkpoint: managedDataUsageCheckpoints,
			})
			.from(managedDataResources)
			.leftJoin(
				managedDataUsageCheckpoints,
				eq(
					managedDataUsageCheckpoints.managedDataResourceId,
					managedDataResources.managedDataResourceId,
				),
			)
			.where(
				and(
					eq(managedDataResources.status, "ready"),
					sql`${managedDataResources.providerResourceId} is not null`,
					sql`${managedDataResources.nextUsageAt} <= ${now}`,
				),
			)
			.orderBy(asc(managedDataResources.nextUsageAt))
			.limit(maxResources);
		let reconciled = 0;
		let failed = 0;
		for (const row of resources) {
			const resource = row.resource;
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
					if (checkpoint && usage.observedAt <= checkpoint.lastSampleAt) {
						await tx
							.update(managedDataResources)
							.set({
								usageAttempts: 0,
								nextUsageAt: new Date(now.getTime() + 15 * 60_000),
							})
							.where(
								eq(
									managedDataResources.managedDataResourceId,
									resource.managedDataResourceId,
								),
							);
						return;
					}
					const period = managedDataUsagePeriod(
						checkpoint?.lastMeteredAt ?? null,
						usage.observedAt,
						resource.createdAt,
					);
					if (!period) {
						await tx
							.update(managedDataResources)
							.set({
								usageAttempts: 0,
								nextUsageAt: new Date(now.getTime() + 15 * 60_000),
							})
							.where(
								eq(
									managedDataResources.managedDataResourceId,
									resource.managedDataResourceId,
								),
							);
						return;
					}
					const previousBytes = checkpoint?.metadata.consumedBytes
						? BigInt(String(checkpoint.metadata.consumedBytes))
						: null;
					const meteredBytes = averageDatabaseBytes(
						previousBytes,
						usage.consumedBytes,
					);
					await tx
						.insert(usageEvents)
						.values({
							idempotencyKey: `${resource.managedDataResourceId}:${period.periodEnd.toISOString()}:database-bytes`,
							organizationId: resource.organizationId,
							projectId: resource.projectId,
							environmentId: resource.environmentId,
							metric: "database_byte_seconds",
							source: "database",
							quantity: databaseByteSeconds(
								meteredBytes,
								period.periodEnd.getTime() - period.periodStart.getTime(),
							),
							unit: "byte_seconds",
							periodStart: period.periodStart,
							periodEnd: period.periodEnd,
							metadata: {
								managedDataResourceId: resource.managedDataResourceId,
								provider: resource.provider,
								consumedBytes: meteredBytes.toString(),
							},
						})
						.onConflictDoNothing({ target: usageEvents.idempotencyKey });
					if (
						resource.storageLimitBytes !== null &&
						usage.consumedBytes > resource.storageLimitBytes
					) {
						await tx
							.update(managedDataResources)
							.set({
								metadata: {
									...resource.metadata,
									quotaExceeded: true,
									quotaObservedAt: usage.observedAt.toISOString(),
								},
								updatedAt: new Date(),
							})
							.where(
								eq(
									managedDataResources.managedDataResourceId,
									resource.managedDataResourceId,
								),
							);
					}
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
					await tx
						.update(managedDataResources)
						.set({
							usageAttempts: 0,
							nextUsageAt: new Date(now.getTime() + 15 * 60_000),
						})
						.where(
							eq(
								managedDataResources.managedDataResourceId,
								resource.managedDataResourceId,
							),
						);
				});
				reconciled += 1;
			} catch (error) {
				failed += 1;
				const attempts = resource.usageAttempts + 1;
				await db
					.update(managedDataResources)
					.set({
						usageAttempts: attempts,
						nextUsageAt: new Date(
							now.getTime() +
								Math.min(60_000 * 2 ** Math.min(attempts - 1, 6), 60 * 60_000),
						),
					})
					.where(
						eq(
							managedDataResources.managedDataResourceId,
							resource.managedDataResourceId,
						),
					);
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
