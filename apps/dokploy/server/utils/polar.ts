import { IS_HOSTED } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import { organization, server, user } from "@dokploy/server/db/schema";
import { polarUsageCutover } from "@dokploy/server/services/polar-usage-metering";
import {
	createPolar,
	type Environment,
	type models,
	type Polar,
} from "@polar-sh/sdk/2026-04";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

export type BillingPlan = "legacy" | "hobby" | "startup";
export type BillingInterval = "month" | "year";
export type PolarSubscriptionSeatOverride = {
	subscriptionId: string;
	seats?: number | null;
};
export type PolarStateSyncOptions = {
	seatOverride?: PolarSubscriptionSeatOverride;
	eventTimestamp?: Date;
};

const ACCESS_TOKEN_PATTERN = /^polar_oat_[a-zA-Z0-9_-]{12,}$/;
const PRODUCT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,}$/;

export const BILLING_SITE_URL =
	process.env.NODE_ENV === "development"
		? "http://localhost:3000"
		: process.env.PLATFORM_URL ||
			process.env.SITE_URL ||
			process.env.BETTER_AUTH_URL;

const productConfiguration = () =>
	[
		{
			tier: "legacy" as const,
			interval: "month" as const,
			productId: process.env.POLAR_LEGACY_MONTHLY_PRODUCT_ID?.trim() || "",
		},
		{
			tier: "legacy" as const,
			interval: "year" as const,
			productId: process.env.POLAR_LEGACY_ANNUAL_PRODUCT_ID?.trim() || "",
		},
		{
			tier: "hobby" as const,
			interval: "month" as const,
			productId: process.env.POLAR_HOBBY_MONTHLY_PRODUCT_ID?.trim() || "",
		},
		{
			tier: "hobby" as const,
			interval: "year" as const,
			productId: process.env.POLAR_HOBBY_ANNUAL_PRODUCT_ID?.trim() || "",
		},
		{
			tier: "startup" as const,
			interval: "month" as const,
			productId: process.env.POLAR_STARTUP_MONTHLY_PRODUCT_ID?.trim() || "",
		},
		{
			tier: "startup" as const,
			interval: "year" as const,
			productId: process.env.POLAR_STARTUP_ANNUAL_PRODUCT_ID?.trim() || "",
		},
	].filter((entry) => entry.productId);

export const polarEnvironment = (): Environment => {
	const configured = process.env.POLAR_ENVIRONMENT?.trim().toLowerCase();
	if (configured === "production" || configured === "sandbox")
		return configured;
	if (configured)
		throw new Error("POLAR_ENVIRONMENT must be production or sandbox");
	return process.env.NODE_ENV === "production" ? "production" : "sandbox";
};

export const polarAccessToken = () => {
	const accessToken = process.env.POLAR_ACCESS_TOKEN?.trim();
	if (!accessToken || !ACCESS_TOKEN_PATTERN.test(accessToken)) {
		throw new Error("POLAR_ACCESS_TOKEN must be a valid Polar access token");
	}
	return accessToken;
};

export const getPolarClient = (): Polar =>
	createPolar({
		accessToken: polarAccessToken(),
		environment: polarEnvironment(),
	});

export const configuredPolarProductIds = () =>
	productConfiguration().map((entry) => entry.productId);

export const billingProductFor = (tier: BillingPlan, isAnnual: boolean) => {
	const interval: BillingInterval = isAnnual ? "year" : "month";
	const product = productConfiguration().find(
		(entry) => entry.tier === tier && entry.interval === interval,
	);
	if (!product) {
		throw new Error(`Polar ${tier} ${interval} product is not configured`);
	}
	return product;
};

export const billingPlanForProduct = (productId: string) =>
	productConfiguration().find((entry) => entry.productId === productId)?.tier ??
	null;

export const billingIntervalForProduct = (productId: string) =>
	productConfiguration().find((entry) => entry.productId === productId)
		?.interval ?? null;

export const assertPolarConfiguration = () => {
	if (!IS_HOSTED || process.env.NODE_ENV !== "production") return;
	const required = [
		"POLAR_ACCESS_TOKEN",
		"POLAR_WEBHOOK_SECRET",
		"POLAR_ORGANIZATION_ID",
		"POLAR_HOBBY_MONTHLY_PRODUCT_ID",
		"POLAR_HOBBY_ANNUAL_PRODUCT_ID",
		"POLAR_STARTUP_MONTHLY_PRODUCT_ID",
		"POLAR_STARTUP_ANNUAL_PRODUCT_ID",
	] as const;
	const missing = required.filter((name) => !process.env[name]?.trim());
	if (missing.length > 0) {
		throw new Error(`Hosted billing requires ${missing.join(", ")}`);
	}
	polarAccessToken();
	polarEnvironment();
	polarUsageCutover();
	for (const productId of configuredPolarProductIds()) {
		if (!PRODUCT_ID_PATTERN.test(productId)) {
			throw new Error("A configured Polar product ID is invalid");
		}
	}
	if (!BILLING_SITE_URL || new URL(BILLING_SITE_URL).protocol !== "https:") {
		throw new Error("Hosted Polar billing requires an HTTPS platform URL");
	}
};

export const verifyPolarConfiguration = async (polar?: Polar) => {
	if (!IS_HOSTED || process.env.NODE_ENV !== "production") return true;
	const client = polar ?? getPolarClient();
	const organizationId = process.env.POLAR_ORGANIZATION_ID?.trim();
	if (!organizationId) throw new Error("POLAR_ORGANIZATION_ID is required");
	const remoteOrganization = await client.organizations.get(organizationId);
	if (remoteOrganization.id !== organizationId) {
		throw new Error("Polar access token does not match POLAR_ORGANIZATION_ID");
	}
	const configured = productConfiguration();
	if (
		new Set(configured.map((entry) => entry.productId)).size !==
		configured.length
	) {
		throw new Error("Polar product IDs must be unique");
	}
	for (const product of configured) {
		const remote = await client.products.get(product.productId);
		if (remote.organization_id !== organizationId || remote.is_archived) {
			throw new Error(
				`Polar ${product.tier} ${product.interval} product is invalid`,
			);
		}
		if (remote.recurring_interval !== product.interval) {
			throw new Error(
				`Polar ${product.tier} product must recur every ${product.interval}`,
			);
		}
		const activePrices = remote.prices.filter(
			(price) => "is_archived" in price && !price.is_archived,
		);
		const basePrices = activePrices.filter(
			(price) => price.amount_type !== "metered_unit",
		);
		if (basePrices.length !== 1) {
			throw new Error(
				`Polar ${product.tier} ${product.interval} product must have exactly one active fixed or seat price`,
			);
		}
	}
	return true;
};

export const isPolarNotFound = (error: unknown) =>
	Boolean(
		error &&
			typeof error === "object" &&
			"statusCode" in error &&
			(error as { statusCode?: number }).statusCode === 404,
	);

export const getPolarCustomerState = async (
	externalCustomerId: string,
	polar = getPolarClient(),
): Promise<models.CustomerState | null> => {
	try {
		return await polar.customers.getStateExternal(externalCustomerId);
	} catch (error) {
		if (isPolarNotFound(error)) return null;
		throw error;
	}
};

export const assertPolarOrganization = (polarOrganizationId: string) => {
	const expected = process.env.POLAR_ORGANIZATION_ID?.trim();
	if (expected && expected !== polarOrganizationId) {
		throw new Error("Polar payload belongs to another organization");
	}
};

const seatsForSubscription = (
	subscription: models.CustomerStateSubscription,
	plan: BillingPlan | null,
	current?: {
		polarSubscriptionId: string | null;
		billingSeats: number;
	},
	override?: PolarSubscriptionSeatOverride,
) => {
	if (
		override?.subscriptionId === subscription.id &&
		typeof override.seats === "number" &&
		Number.isFinite(override.seats)
	) {
		return Math.max(Math.trunc(override.seats), 1);
	}
	const metadata = subscription.metadata as Record<string, unknown>;
	const configuredSeats = metadata.serverQuantity ?? metadata.seats;
	if (typeof configuredSeats === "number" && Number.isFinite(configuredSeats)) {
		return Math.max(Math.trunc(configuredSeats), 1);
	}
	if (
		current?.polarSubscriptionId === subscription.id &&
		current.billingSeats > 0
	) {
		return current.billingSeats;
	}
	return plan === "startup" ? 3 : 1;
};

export const resolvePolarCustomerBillingState = (
	state: models.CustomerState,
	current?: {
		polarSubscriptionId: string | null;
		billingSeats: number;
	},
	seatOverride?: PolarSubscriptionSeatOverride,
) => {
	const externalCustomerId = state.external_id;
	if (!externalCustomerId) return null;
	const subscription = state.active_subscriptions.find((entry) =>
		configuredPolarProductIds().includes(entry.product_id),
	);
	const plan = subscription
		? billingPlanForProduct(subscription.product_id)
		: null;
	const billingSeats = subscription
		? seatsForSubscription(subscription, plan, current, seatOverride)
		: 0;
	return {
		externalCustomerId,
		subscription,
		plan,
		billingSeats,
		organizationState: {
			polarCustomerId: state.id,
			polarSubscriptionId: subscription?.id ?? null,
			billingPlan: plan,
			billingStatus: subscription?.status ?? null,
			billingSeats,
			billingCurrentPeriodEnd: subscription
				? new Date(subscription.current_period_end)
				: null,
			billingLastSyncedAt: new Date(),
		},
	};
};

const updateOrganizationServersBasedOnQuantity = async (
	organizationId: string,
	serversQuantity: number,
) => {
	const organizationServers = await db.query.server.findMany({
		where: eq(server.organizationId, organizationId),
		orderBy: [asc(server.createdAt)],
	});
	for (const [index, organizationServer] of organizationServers.entries()) {
		await db
			.update(server)
			.set({ serverStatus: index < serversQuantity ? "active" : "inactive" })
			.where(eq(server.serverId, organizationServer.serverId));
	}
};

export const updateServersBasedOnQuantity = async (
	ownerId: string,
	serversQuantity: number,
) => {
	const organizations = await db.query.organization.findMany({
		where: eq(organization.ownerId, ownerId),
		columns: { id: true },
	});
	const organizationIds = organizations.map((entry) => entry.id);
	if (organizationIds.length === 0) return;
	const ownedServers = await db.query.server.findMany({
		where: inArray(server.organizationId, organizationIds),
		orderBy: [asc(server.createdAt)],
	});
	for (const [index, ownedServer] of ownedServers.entries()) {
		await db
			.update(server)
			.set({ serverStatus: index < serversQuantity ? "active" : "inactive" })
			.where(eq(server.serverId, ownedServer.serverId));
	}
};

const updateOwnerServerQuota = async (ownerId: string) => {
	const [quota] = await db
		.select({
			total: sql<number>`coalesce(sum(${organization.billingSeats}), 0)::integer`,
		})
		.from(organization)
		.where(
			and(
				eq(organization.ownerId, ownerId),
				inArray(organization.billingStatus, ["active", "trialing"]),
			),
		);
	const serversQuantity = Math.max(quota?.total ?? 0, 0);
	await db.update(user).set({ serversQuantity }).where(eq(user.id, ownerId));
	return serversQuantity;
};

export const synchronizePolarCustomerState = async (
	state: models.CustomerState,
	options: PolarStateSyncOptions = {},
) => {
	assertPolarOrganization(state.organization_id);
	const externalCustomerId = state.external_id;
	if (!externalCustomerId) return null;
	const localOrganization = await db.query.organization.findFirst({
		where: eq(organization.id, externalCustomerId),
	});
	if (!localOrganization) return null;
	if (
		options.eventTimestamp &&
		localOrganization.billingLastEventAt &&
		options.eventTimestamp < localOrganization.billingLastEventAt
	) {
		return null;
	}

	const resolved = resolvePolarCustomerBillingState(
		state,
		localOrganization,
		options.seatOverride,
	);
	if (!resolved) return null;
	await db
		.update(organization)
		.set({
			...resolved.organizationState,
			billingLastEventAt:
				options.eventTimestamp ?? localOrganization.billingLastEventAt,
		})
		.where(eq(organization.id, localOrganization.id));
	await updateOrganizationServersBasedOnQuantity(
		localOrganization.id,
		resolved.billingSeats,
	);
	await updateOwnerServerQuota(localOrganization.ownerId);
	return {
		organizationId: localOrganization.id,
		ownerId: localOrganization.ownerId,
		plan: resolved.plan,
		billingSeats: resolved.billingSeats,
		subscription: resolved.subscription,
	};
};

export const clearPolarCustomerState = async (
	externalCustomerId: string,
	polarCustomerId?: string,
	eventTimestamp?: Date,
) => {
	const localOrganization = await db.query.organization.findFirst({
		where: eq(organization.id, externalCustomerId),
	});
	if (
		!localOrganization ||
		(eventTimestamp &&
			localOrganization.billingLastEventAt &&
			eventTimestamp < localOrganization.billingLastEventAt) ||
		(polarCustomerId &&
			localOrganization.polarCustomerId &&
			localOrganization.polarCustomerId !== polarCustomerId)
	) {
		return false;
	}
	await db
		.update(organization)
		.set({
			polarCustomerId: null,
			polarSubscriptionId: null,
			billingPlan: null,
			billingStatus: null,
			billingSeats: 0,
			billingCurrentPeriodEnd: null,
			billingLastSyncedAt: new Date(),
			billingLastEventAt:
				eventTimestamp ?? localOrganization.billingLastEventAt,
		})
		.where(eq(organization.id, localOrganization.id));
	await updateOrganizationServersBasedOnQuantity(localOrganization.id, 0);
	await updateOwnerServerQuota(localOrganization.ownerId);
	return true;
};

export const reconcilePolarCustomerStates = async (
	polar = getPolarClient(),
	limit = 100,
) => {
	const organizations = await db.query.organization.findMany({
		where: (table, { isNotNull }) => isNotNull(table.polarCustomerId),
		orderBy: [asc(organization.billingLastSyncedAt)],
		limit,
	});
	let synchronized = 0;
	let cleared = 0;
	let failed = 0;
	for (const localOrganization of organizations) {
		try {
			const state = await getPolarCustomerState(localOrganization.id, polar);
			if (state) {
				await synchronizePolarCustomerState(state);
				synchronized += 1;
			} else {
				await clearPolarCustomerState(localOrganization.id);
				cleared += 1;
			}
		} catch (error) {
			failed += 1;
			console.error(
				`Failed to reconcile Polar customer state for organization ${localOrganization.id}`,
				error,
			);
		}
	}
	return { synchronized, cleared, failed };
};

export const polarProductCatalog = async (polar = getPolarClient()) => {
	const configured = productConfiguration();
	if (configured.length === 0) return [];
	const response = await polar.products.list({
		id: configured.map((entry) => entry.productId),
		is_archived: false,
		limit: Math.min(configured.length, 100),
	});
	const products = new Map(
		response.items.map((product) => [product.id, product]),
	);
	return configured.flatMap((entry) => {
		const product = products.get(entry.productId);
		if (!product) return [];
		const price = product.prices.find(
			(candidate) =>
				"is_archived" in candidate &&
				!candidate.is_archived &&
				candidate.amount_type !== "metered_unit",
		);
		const priceAmount =
			price && "amount_type" in price
				? price.amount_type === "fixed"
					? price.price_amount
					: price.amount_type === "seat_based"
						? (price.seat_tiers.tiers[0]?.price_per_seat ?? null)
						: null
				: null;
		const priceCurrency =
			price && "price_currency" in price ? price.price_currency : "usd";
		const seatTiers =
			price && "amount_type" in price && price.amount_type === "seat_based"
				? price.seat_tiers.tiers.map((tier) => ({
						minSeats: tier.min_seats,
						maxSeats: tier.max_seats ?? null,
						pricePerSeat: tier.price_per_seat,
					}))
				: [];
		return [
			{
				id: product.id,
				name: product.name,
				description: product.description,
				tier: entry.tier,
				interval: entry.interval,
				priceAmount,
				priceCurrency,
				seatTiers,
				seatBased:
					Boolean(price && "amount_type" in price) &&
					price?.amount_type === "seat_based",
			},
		];
	});
};
