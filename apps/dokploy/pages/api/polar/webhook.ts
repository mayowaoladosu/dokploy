import { findUserById } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { organization, polarWebhookEvents } from "@dokploy/server/db/schema";
import { webhooks } from "@polar-sh/sdk/2026-04";
import { and, eq, lt, or, sql } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	assertPolarOrganization,
	clearPolarCustomerState,
	getPolarClient,
	getPolarCustomerState,
	synchronizePolarCustomerState,
} from "@/server/utils/polar";
import {
	sendPolarOrderPaidEmail,
	sendPolarPaymentFailedEmail,
} from "@/server/utils/polar-notifications";

export const config = {
	api: {
		bodyParser: false,
	},
};

const MAX_WEBHOOK_BYTES = 1024 * 1024;

const readWebhookBody = async (req: NextApiRequest) => {
	const contentLength = Number.parseInt(
		req.headers["content-length"] || "0",
		10,
	);
	if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
		throw new Error("Polar webhook body is too large");
	}
	const chunks: Buffer[] = [];
	let received = 0;
	for await (const chunk of req) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		received += bytes.byteLength;
		if (received > MAX_WEBHOOK_BYTES) {
			throw new Error("Polar webhook body is too large");
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks);
};

const normalizedHeaders = (req: NextApiRequest) =>
	Object.fromEntries(
		Object.entries(req.headers).flatMap(([name, value]) => {
			if (typeof value === "string") return [[name, value]];
			if (Array.isArray(value)) return [[name, value.join(",")]];
			return [];
		}),
	);

export const claimPolarWebhook = async (
	eventId: string,
	type: string,
	payloadTimestamp: Date,
) => {
	const [inserted] = await db
		.insert(polarWebhookEvents)
		.values({ polarWebhookEventId: eventId, type, payloadTimestamp })
		.onConflictDoNothing()
		.returning({ id: polarWebhookEvents.polarWebhookEventId });
	if (inserted) return "claimed" as const;

	const staleBefore = new Date(Date.now() - 10 * 60_000);
	const [reclaimed] = await db
		.update(polarWebhookEvents)
		.set({
			status: "processing",
			attempts: sql`${polarWebhookEvents.attempts} + 1`,
			lastError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(polarWebhookEvents.polarWebhookEventId, eventId),
				or(
					eq(polarWebhookEvents.status, "failed"),
					and(
						eq(polarWebhookEvents.status, "processing"),
						lt(polarWebhookEvents.updatedAt, staleBefore),
					),
				),
			),
		)
		.returning({ id: polarWebhookEvents.polarWebhookEventId });
	if (reclaimed) return "claimed" as const;
	const existing = await db.query.polarWebhookEvents.findFirst({
		where: eq(polarWebhookEvents.polarWebhookEventId, eventId),
		columns: { status: true },
	});
	return existing?.status === "processed"
		? ("processed" as const)
		: ("busy" as const);
};

const synchronizeExternalCustomer = async (
	externalCustomerId: string,
	seatOverride?: { subscriptionId: string; seats?: number | null },
	eventTimestamp?: Date,
) => {
	const polar = getPolarClient();
	const state = await getPolarCustomerState(externalCustomerId, polar);
	if (!state) {
		await clearPolarCustomerState(externalCustomerId);
		return null;
	}
	return synchronizePolarCustomerState(state, { seatOverride, eventTimestamp });
};

const processPayload = async (
	payload: Awaited<ReturnType<typeof webhooks.validateEvent>>,
) => {
	switch (payload.type) {
		case "customer.state_changed":
			await synchronizePolarCustomerState(payload.data, {
				eventTimestamp: new Date(payload.timestamp),
			});
			return;
		case "customer.deleted": {
			assertPolarOrganization(payload.data.organization_id);
			if (payload.data.external_id) {
				await clearPolarCustomerState(
					payload.data.external_id,
					payload.data.id,
					new Date(payload.timestamp),
				);
			}
			return;
		}
		case "subscription.active":
		case "subscription.canceled":
		case "subscription.created":
		case "subscription.past_due":
		case "subscription.paused":
		case "subscription.resumed":
		case "subscription.revoked":
		case "subscription.uncanceled":
		case "subscription.updated": {
			assertPolarOrganization(payload.data.customer.organization_id);
			const externalCustomerId = payload.data.customer.external_id;
			if (!externalCustomerId) return;
			const synchronized = await synchronizeExternalCustomer(
				externalCustomerId,
				{
					subscriptionId: payload.data.id,
					seats: payload.data.seats,
				},
				new Date(payload.timestamp),
			);
			if (payload.type !== "subscription.past_due" || !synchronized) return;
			const localOrganization = await db.query.organization.findFirst({
				where: eq(organization.id, synchronized.organizationId),
			});
			if (!localOrganization) return;
			const admin = await findUserById(localOrganization.ownerId);
			if (!admin.sendInvoiceNotifications) return;
			const polar = getPolarClient();
			const session = await polar.customerSessions.create({
				external_customer_id: externalCustomerId,
				return_url:
					process.env.PLATFORM_URL || process.env.BETTER_AUTH_URL || undefined,
			});
			await sendPolarPaymentFailedEmail({
				subscription: payload.data,
				admin,
				portalUrl: session.customer_portal_url,
			});
			return;
		}
		case "order.paid": {
			assertPolarOrganization(payload.data.customer.organization_id);
			const externalCustomerId = payload.data.customer.external_id;
			if (!externalCustomerId) return;
			const synchronized =
				await synchronizeExternalCustomer(externalCustomerId);
			if (!synchronized) return;
			const localOrganization = await db.query.organization.findFirst({
				where: eq(organization.id, synchronized.organizationId),
			});
			if (!localOrganization) return;
			const admin = await findUserById(localOrganization.ownerId);
			if (admin.sendInvoiceNotifications) {
				await sendPolarOrderPaidEmail({
					order: payload.data,
					admin,
					polar: getPolarClient(),
				});
			}
			return;
		}
		default:
			return;
	}
};

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	if (req.method !== "POST") {
		res.setHeader("Allow", "POST");
		return res.status(405).send("Method Not Allowed");
	}
	const secret = process.env.POLAR_WEBHOOK_SECRET?.trim();
	if (!secret) return res.status(503).send("Polar webhook is not configured");
	const headers = normalizedHeaders(req);
	let payload: Awaited<ReturnType<typeof webhooks.validateEvent>>;
	try {
		payload = await webhooks.validateEvent(
			await readWebhookBody(req),
			headers,
			secret,
		);
	} catch (error) {
		if (error instanceof Error && error.message.includes("too large")) {
			return res.status(413).send("Webhook payload too large");
		}
		console.error(
			"Polar webhook signature verification failed",
			error instanceof Error ? error.message : error,
		);
		return res.status(400).send("Invalid webhook signature");
	}

	const eventId = headers["webhook-id"];
	const payloadTimestamp = new Date(payload.timestamp);
	if (!eventId || !Number.isFinite(payloadTimestamp.getTime())) {
		return res.status(400).send("Invalid webhook envelope");
	}
	const claim = await claimPolarWebhook(
		eventId,
		payload.type,
		payloadTimestamp,
	);
	if (claim === "processed") {
		return res.status(200).json({ received: true, duplicate: true });
	}
	if (claim === "busy") {
		return res.status(409).send("Webhook delivery is already processing");
	}

	try {
		await processPayload(payload);
		await db
			.update(polarWebhookEvents)
			.set({
				status: "processed",
				processedAt: new Date(),
				lastError: null,
				updatedAt: new Date(),
			})
			.where(eq(polarWebhookEvents.polarWebhookEventId, eventId));
		return res.status(200).json({ received: true });
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Polar webhook processing failed";
		await db
			.update(polarWebhookEvents)
			.set({
				status: "failed",
				lastError: message.slice(0, 1_000),
				updatedAt: new Date(),
			})
			.where(eq(polarWebhookEvents.polarWebhookEventId, eventId));
		console.error("Polar webhook processing failed", error);
		return res.status(500).send("Webhook processing failed");
	}
}
