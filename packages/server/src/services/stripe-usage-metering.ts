import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	stripeUsageDeliveries,
	stripeUsageMeters,
	type UsageMetric,
	usageEvents,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_CUSTOMER_ID = /^cus_[a-zA-Z0-9]{8,}$/;
const STRIPE_EVENT_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/;
const MAX_BATCH_SIZE = 500;

export const upsertStripeUsageMeter = async (input: {
	organizationId: string;
	metric: UsageMetric;
	stripeCustomerId: string;
	stripeEventName: string;
	enabled?: boolean;
	metadata?: Record<string, unknown>;
}) => {
	if (!STRIPE_CUSTOMER_ID.test(input.stripeCustomerId)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Stripe customer ID is invalid",
		});
	}
	if (!STRIPE_EVENT_NAME.test(input.stripeEventName)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Stripe meter event name is invalid",
		});
	}
	const [meter] = await db
		.insert(stripeUsageMeters)
		.values(input)
		.onConflictDoUpdate({
			target: [stripeUsageMeters.organizationId, stripeUsageMeters.metric],
			set: {
				stripeCustomerId: input.stripeCustomerId,
				stripeEventName: input.stripeEventName,
				enabled: input.enabled ?? true,
				metadata: input.metadata ?? {},
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!meter) throw new Error("Failed to persist Stripe usage meter");
	return meter;
};

export const listStripeUsageMeters = async (organizationId?: string) =>
	db.query.stripeUsageMeters.findMany({
		where: organizationId
			? eq(stripeUsageMeters.organizationId, organizationId)
			: undefined,
		orderBy: [asc(stripeUsageMeters.createdAt)],
	});

export const stripeMeterEventIdentifier = (
	stripeUsageMeterId: string,
	usageEventId: string,
) =>
	`vlyv_${createHash("sha256")
		.update(`${stripeUsageMeterId}:${usageEventId}`)
		.digest("hex")}`;

export const createStripeMeterEventClient = ({
	apiKey,
	apiBase = STRIPE_API_BASE,
	fetcher = fetch,
}: {
	apiKey: string;
	apiBase?: string;
	fetcher?: typeof fetch;
}) => {
	if (!apiKey.trim().startsWith("sk_")) {
		throw new Error("Stripe usage export requires a secret API key");
	}
	const base = new URL(apiBase);
	if (base.protocol !== "https:" || base.username || base.password) {
		throw new Error("Stripe API endpoint must use clean HTTPS");
	}
	return {
		send: async (input: {
			eventName: string;
			identifier: string;
			customerId: string;
			quantity: bigint;
			timestamp: Date;
		}) => {
			const body = new URLSearchParams({
				event_name: input.eventName,
				identifier: input.identifier,
				timestamp: String(Math.floor(input.timestamp.getTime() / 1_000)),
				"payload[stripe_customer_id]": input.customerId,
				"payload[value]": input.quantity.toString(),
			});
			const response = await fetcher(
				`${base.toString().replace(/\/$/, "")}/billing/meter_events`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/x-www-form-urlencoded",
						"Idempotency-Key": input.identifier,
						"Stripe-Version": "2024-09-30.acacia",
					},
					body,
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!response.ok) {
				const requestId = response.headers.get("request-id");
				throw new Error(
					`Stripe meter event failed (${response.status}${requestId ? `, ${requestId}` : ""})`,
				);
			}
			return true;
		},
	};
};

export type StripeMeterEventClient = ReturnType<
	typeof createStripeMeterEventClient
>;

const seedStripeUsageDeliveries = async (limit: number, now: Date) => {
	const candidates = await db
		.select({
			usageEventId: usageEvents.usageEventId,
			stripeUsageMeterId: stripeUsageMeters.stripeUsageMeterId,
			stripeCustomerId: stripeUsageMeters.stripeCustomerId,
			stripeEventName: stripeUsageMeters.stripeEventName,
			quantity: usageEvents.quantity,
			eventTimestamp: usageEvents.createdAt,
		})
		.from(usageEvents)
		.innerJoin(
			stripeUsageMeters,
			and(
				eq(stripeUsageMeters.organizationId, usageEvents.organizationId),
				eq(stripeUsageMeters.metric, usageEvents.metric),
				eq(stripeUsageMeters.enabled, true),
			),
		)
		.leftJoin(
			stripeUsageDeliveries,
			and(
				eq(
					stripeUsageDeliveries.stripeUsageMeterId,
					stripeUsageMeters.stripeUsageMeterId,
				),
				eq(stripeUsageDeliveries.usageEventId, usageEvents.usageEventId),
			),
		)
		.where(
			and(
				isNull(stripeUsageDeliveries.stripeUsageDeliveryId),
				gte(
					usageEvents.createdAt,
					new Date(now.getTime() - 34 * 24 * 60 * 60 * 1_000),
				),
			),
		)
		.orderBy(asc(usageEvents.createdAt))
		.limit(limit);
	if (candidates.length === 0) return 0;
	await db
		.insert(stripeUsageDeliveries)
		.values(
			candidates.map((candidate) => ({
				...candidate,
				identifier: stripeMeterEventIdentifier(
					candidate.stripeUsageMeterId,
					candidate.usageEventId,
				),
			})),
		)
		.onConflictDoNothing();
	return candidates.length;
};

const retryDelayMs = (attempts: number) =>
	Math.min(2 ** Math.min(Math.max(attempts, 1), 10) * 30_000, 60 * 60_000);

export const synchronizeStripeUsage = async ({
	client,
	now = new Date(),
	batchSize = 100,
}: {
	client: StripeMeterEventClient;
	now?: Date;
	batchSize?: number;
}) => {
	if (
		!Number.isSafeInteger(batchSize) ||
		batchSize < 1 ||
		batchSize > MAX_BATCH_SIZE
	) {
		throw new Error(
			`Stripe usage batch size must be from 1 to ${MAX_BATCH_SIZE}`,
		);
	}
	await db
		.update(stripeUsageDeliveries)
		.set({ status: "failed", nextAttemptAt: now, updatedAt: now })
		.where(
			and(
				eq(stripeUsageDeliveries.status, "delivering"),
				lt(
					stripeUsageDeliveries.updatedAt,
					new Date(now.getTime() - 10 * 60_000),
				),
			),
		);
	const seeded = await seedStripeUsageDeliveries(batchSize * 2, now);
	const pending = await db
		.select({ delivery: stripeUsageDeliveries })
		.from(stripeUsageDeliveries)
		.innerJoin(
			stripeUsageMeters,
			and(
				eq(
					stripeUsageMeters.stripeUsageMeterId,
					stripeUsageDeliveries.stripeUsageMeterId,
				),
				eq(stripeUsageMeters.enabled, true),
			),
		)
		.where(
			and(
				inArray(stripeUsageDeliveries.status, ["pending", "failed"]),
				lte(stripeUsageDeliveries.nextAttemptAt, now),
			),
		)
		.orderBy(asc(stripeUsageDeliveries.createdAt))
		.limit(batchSize);
	let delivered = 0;
	let failed = 0;
	for (const { delivery } of pending) {
		const [claimed] = await db
			.update(stripeUsageDeliveries)
			.set({
				status: "delivering",
				attempts: sql`${stripeUsageDeliveries.attempts} + 1`,
				updatedAt: now,
			})
			.where(
				and(
					eq(
						stripeUsageDeliveries.stripeUsageDeliveryId,
						delivery.stripeUsageDeliveryId,
					),
					inArray(stripeUsageDeliveries.status, ["pending", "failed"]),
					lte(stripeUsageDeliveries.nextAttemptAt, now),
				),
			)
			.returning();
		if (!claimed) continue;
		try {
			await client.send({
				eventName: delivery.stripeEventName,
				identifier: delivery.identifier,
				customerId: delivery.stripeCustomerId,
				quantity: delivery.quantity,
				timestamp: delivery.eventTimestamp,
			});
			await db
				.update(stripeUsageDeliveries)
				.set({
					status: "delivered",
					deliveredAt: now,
					lastError: null,
					updatedAt: now,
				})
				.where(
					eq(
						stripeUsageDeliveries.stripeUsageDeliveryId,
						delivery.stripeUsageDeliveryId,
					),
				);
			delivered += 1;
		} catch (error) {
			await db
				.update(stripeUsageDeliveries)
				.set({
					status: "failed",
					nextAttemptAt: new Date(
						now.getTime() + retryDelayMs(claimed.attempts),
					),
					lastError:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Stripe usage delivery failed",
					updatedAt: now,
				})
				.where(
					eq(
						stripeUsageDeliveries.stripeUsageDeliveryId,
						delivery.stripeUsageDeliveryId,
					),
				);
			failed += 1;
		}
	}
	return { seeded, attempted: delivered + failed, delivered, failed };
};
