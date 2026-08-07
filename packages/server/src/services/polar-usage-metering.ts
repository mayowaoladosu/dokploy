import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	polarUsageDeliveries,
	polarUsageMeters,
	type UsageMetric,
	usageEvents,
} from "@dokploy/server/db/schema";
import {
	createPolar,
	type Environment,
	type models,
	type Polar,
} from "@polar-sh/sdk/2026-04";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";

const POLAR_ACCESS_TOKEN = /^polar_oat_[a-zA-Z0-9_-]{12,}$/;
const POLAR_EVENT_NAME = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;
const MAX_BATCH_SIZE = 500;
const DEFAULT_REPLAY_WINDOW_HOURS = 24 * 35;

const replayWindowHours = () => {
	const parsed = Number.parseInt(
		process.env.POLAR_USAGE_MAX_EVENT_AGE_HOURS ||
			String(DEFAULT_REPLAY_WINDOW_HOURS),
		10,
	);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 24 * 35) {
		throw new Error(
			"POLAR_USAGE_MAX_EVENT_AGE_HOURS must be an integer from 1 to 840",
		);
	}
	return parsed;
};

const polarEventPrefix = () => {
	const prefix = process.env.POLAR_USAGE_EVENT_PREFIX?.trim() || "vlyv";
	if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(prefix)) {
		throw new Error("POLAR_USAGE_EVENT_PREFIX is invalid");
	}
	return prefix;
};

export const polarUsageCutover = () => {
	const value = process.env.POLAR_USAGE_CUTOVER_AT?.trim();
	if (!value) {
		throw new Error(
			"POLAR_USAGE_CUTOVER_AT is required before exporting usage to Polar",
		);
	}
	const parsed = new Date(value);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
		!Number.isFinite(parsed.getTime()) ||
		parsed.toISOString() !== value
	) {
		throw new Error(
			"POLAR_USAGE_CUTOVER_AT must be a canonical ISO-8601 UTC timestamp",
		);
	}
	return parsed;
};

export const polarUsageDiscoveryStart = (now: Date) =>
	new Date(
		Math.max(
			now.getTime() - replayWindowHours() * 60 * 60 * 1_000,
			polarUsageCutover().getTime(),
		),
	);

export const defaultPolarEventName = (metric: UsageMetric) =>
	`${polarEventPrefix()}.${metric}`;

export const upsertPolarUsageMeter = async (input: {
	organizationId: string;
	metric: UsageMetric;
	polarEventName: string;
	enabled?: boolean;
	metadata?: Record<string, unknown>;
}) => {
	if (!POLAR_EVENT_NAME.test(input.polarEventName)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Polar meter event name is invalid",
		});
	}
	const [meter] = await db
		.insert(polarUsageMeters)
		.values(input)
		.onConflictDoUpdate({
			target: [polarUsageMeters.organizationId, polarUsageMeters.metric],
			set: {
				polarEventName: input.polarEventName,
				enabled: input.enabled ?? true,
				metadata: input.metadata ?? {},
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!meter) throw new Error("Failed to persist Polar usage meter");
	return meter;
};

export const listPolarUsageMeters = async (organizationId?: string) =>
	db.query.polarUsageMeters.findMany({
		where: organizationId
			? eq(polarUsageMeters.organizationId, organizationId)
			: undefined,
		orderBy: [asc(polarUsageMeters.createdAt)],
	});

export const polarMeterEventIdentifier = (
	polarUsageMeterId: string,
	usageEventId: string,
) =>
	`vlyv_${createHash("sha256")
		.update(`${polarUsageMeterId}:${usageEventId}`)
		.digest("hex")}`;

type PolarEventsApi = Pick<Polar["events"], "ingest">;

export const createPolarEventClient = ({
	accessToken,
	environment = "production",
	client,
}: {
	accessToken: string;
	environment?: Environment;
	client?: { events: PolarEventsApi };
}) => {
	const token = accessToken.trim();
	if (!POLAR_ACCESS_TOKEN.test(token)) {
		throw new Error("Polar usage export requires an organization access token");
	}
	const polar = client ?? createPolar({ accessToken: token, environment });
	return {
		send: async (input: {
			eventName: string;
			identifier: string;
			externalCustomerId: string;
			quantity: bigint;
			timestamp: Date;
		}) => {
			if (!POLAR_EVENT_NAME.test(input.eventName)) {
				throw new Error("Polar meter event name is invalid");
			}
			const quantity = Number(input.quantity);
			if (!Number.isSafeInteger(quantity)) {
				throw new Error("Polar usage quantity exceeds the safe integer range");
			}
			const metadata = {
				quantity,
			} as models.EventMetadataInput &
				Record<string, string | number | boolean>;
			const result = await polar.events.ingest({
				events: [
					{
						name: input.eventName,
						external_id: input.identifier,
						external_customer_id: input.externalCustomerId,
						timestamp: input.timestamp.toISOString(),
						metadata,
					},
				],
			});
			if (result.inserted + (result.duplicates ?? 0) !== 1) {
				throw new Error("Polar did not acknowledge the usage event");
			}
			return true;
		},
	};
};

export type PolarEventClient = ReturnType<typeof createPolarEventClient>;

const ensurePolarUsageMeters = async (discoveryStart: Date) => {
	const pairs = await db
		.selectDistinct({
			organizationId: usageEvents.organizationId,
			metric: usageEvents.metric,
		})
		.from(usageEvents)
		.where(gte(usageEvents.createdAt, discoveryStart));
	if (pairs.length === 0) return 0;
	const inserted = await db
		.insert(polarUsageMeters)
		.values(
			pairs.map((pair) => ({
				...pair,
				polarEventName: defaultPolarEventName(pair.metric),
			})),
		)
		.onConflictDoNothing({
			target: [polarUsageMeters.organizationId, polarUsageMeters.metric],
		})
		.returning({ id: polarUsageMeters.polarUsageMeterId });
	return inserted.length;
};

const seedPolarUsageDeliveries = async (
	limit: number,
	discoveryStart: Date,
) => {
	await ensurePolarUsageMeters(discoveryStart);
	const candidates = await db
		.select({
			usageEventId: usageEvents.usageEventId,
			polarUsageMeterId: polarUsageMeters.polarUsageMeterId,
			externalCustomerId: usageEvents.organizationId,
			polarEventName: polarUsageMeters.polarEventName,
			quantity: usageEvents.quantity,
			eventTimestamp: usageEvents.createdAt,
		})
		.from(usageEvents)
		.innerJoin(
			polarUsageMeters,
			and(
				eq(polarUsageMeters.organizationId, usageEvents.organizationId),
				eq(polarUsageMeters.metric, usageEvents.metric),
				eq(polarUsageMeters.enabled, true),
			),
		)
		.leftJoin(
			polarUsageDeliveries,
			and(
				eq(
					polarUsageDeliveries.polarUsageMeterId,
					polarUsageMeters.polarUsageMeterId,
				),
				eq(polarUsageDeliveries.usageEventId, usageEvents.usageEventId),
			),
		)
		.where(
			and(
				isNull(polarUsageDeliveries.polarUsageDeliveryId),
				gte(usageEvents.createdAt, discoveryStart),
			),
		)
		.orderBy(asc(usageEvents.createdAt))
		.limit(limit);
	if (candidates.length === 0) return 0;
	await db
		.insert(polarUsageDeliveries)
		.values(
			candidates.map((candidate) => ({
				...candidate,
				identifier: polarMeterEventIdentifier(
					candidate.polarUsageMeterId,
					candidate.usageEventId,
				),
			})),
		)
		.onConflictDoNothing();
	return candidates.length;
};

const retryDelayMs = (attempts: number) =>
	Math.min(2 ** Math.min(Math.max(attempts, 1), 10) * 30_000, 60 * 60_000);

export const synchronizePolarUsage = async ({
	client,
	now = new Date(),
	batchSize = 100,
}: {
	client: PolarEventClient;
	now?: Date;
	batchSize?: number;
}) => {
	if (
		!Number.isSafeInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > MAX_BATCH_SIZE
	) {
		throw new Error(
			`Polar usage batch size must be from 1 to ${MAX_BATCH_SIZE}`,
		);
	}
	const discoveryStart = polarUsageDiscoveryStart(now);
	await db
		.update(polarUsageDeliveries)
		.set({ status: "failed", nextAttemptAt: now, updatedAt: now })
		.where(
			and(
				eq(polarUsageDeliveries.status, "delivering"),
				lt(
					polarUsageDeliveries.updatedAt,
					new Date(now.getTime() - 10 * 60_000),
				),
			),
		);
	const seeded = await seedPolarUsageDeliveries(batchSize * 2, discoveryStart);
	const pending = await db
		.select({ delivery: polarUsageDeliveries })
		.from(polarUsageDeliveries)
		.innerJoin(
			polarUsageMeters,
			and(
				eq(
					polarUsageMeters.polarUsageMeterId,
					polarUsageDeliveries.polarUsageMeterId,
				),
				eq(polarUsageMeters.enabled, true),
			),
		)
		.where(
			and(
				inArray(polarUsageDeliveries.status, ["pending", "failed"]),
				lte(polarUsageDeliveries.nextAttemptAt, now),
				gte(polarUsageDeliveries.eventTimestamp, discoveryStart),
			),
		)
		.orderBy(asc(polarUsageDeliveries.createdAt))
		.limit(batchSize);
	let delivered = 0;
	let failed = 0;
	for (const { delivery } of pending) {
		const [claimed] = await db
			.update(polarUsageDeliveries)
			.set({
				status: "delivering",
				attempts: sql`${polarUsageDeliveries.attempts} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(
						polarUsageDeliveries.polarUsageDeliveryId,
						delivery.polarUsageDeliveryId,
					),
					inArray(polarUsageDeliveries.status, ["pending", "failed"]),
					lte(polarUsageDeliveries.nextAttemptAt, now),
				),
			)
			.returning();
		if (!claimed) continue;
		try {
			await client.send({
				eventName: delivery.polarEventName,
				identifier: delivery.identifier,
				externalCustomerId: delivery.externalCustomerId,
				quantity: delivery.quantity,
				timestamp: delivery.eventTimestamp,
			});
			await db
				.update(polarUsageDeliveries)
				.set({
					status: "delivered",
					deliveredAt: now,
					lastError: null,
					updatedAt: now,
				})
				.where(
					eq(
						polarUsageDeliveries.polarUsageDeliveryId,
						delivery.polarUsageDeliveryId,
					),
				);
			delivered += 1;
		} catch (error) {
			await db
				.update(polarUsageDeliveries)
				.set({
					status: "failed",
					nextAttemptAt: new Date(
						now.getTime() + retryDelayMs(claimed.attempts),
					),
					lastError:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Polar usage delivery failed",
					updatedAt: now,
				})
				.where(
					eq(
						polarUsageDeliveries.polarUsageDeliveryId,
						delivery.polarUsageDeliveryId,
					),
				);
			failed += 1;
		}
	}
	return { seeded, attempted: delivered + failed, delivered, failed };
};
