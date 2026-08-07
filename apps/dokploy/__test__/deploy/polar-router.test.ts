import { findUserById } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const polarMocks = vi.hoisted(() => ({
	getPolarClient: vi.fn(),
	getCustomerState: vi.fn(),
	synchronizeCustomerState: vi.fn(),
	subscriptionGet: vi.fn(),
	subscriptionUpdate: vi.fn(),
	productGet: vi.fn(),
	ordersList: vi.fn(),
}));

vi.mock("@dokploy/server", () => ({
	findUserById: vi.fn(),
	IS_HOSTED: true,
	IS_MANAGED_PAAS: false,
	updateUser: vi.fn(),
}));

vi.mock("@/server/utils/polar", () => ({
	BILLING_SITE_URL: "https://vlyv.dev",
	billingIntervalForProduct: vi.fn(() => "month"),
	billingPlanForProduct: vi.fn(() => "hobby"),
	billingProductFor: vi.fn(() => ({
		tier: "hobby",
		interval: "month",
		productId: "product-hobby-monthly",
	})),
	getPolarClient: polarMocks.getPolarClient,
	getPolarCustomerState: polarMocks.getCustomerState,
	isPolarNotFound: vi.fn(() => false),
	polarProductCatalog: vi.fn(async () => []),
	synchronizePolarCustomerState: polarMocks.synchronizeCustomerState,
}));

import { polarRouter } from "@/server/api/routers/polar";

const organization = {
	id: "organization-1",
	name: "Acme",
	ownerId: "owner-1",
	polarCustomerId: "customer-1",
	polarSubscriptionId: "subscription-1",
	billingPlan: "hobby",
	billingStatus: "active",
	billingSeats: 2,
};

const caller = () =>
	polarRouter.createCaller({
		session: {
			activeOrganizationId: "organization-1",
			apiCredentialScope: null,
		},
		user: {
			id: "owner-1",
			ownerId: "owner-1",
			role: "owner",
		},
		req: { headers: {} },
		res: {},
	} as never);

describe("Polar subscription router", () => {
	beforeEach(() => {
		vi.mocked(findUserById).mockResolvedValue({
			id: "owner-1",
			email: "owner@vlyv.dev",
			isEnterpriseCloud: false,
			sendInvoiceNotifications: true,
		} as never);
		vi.mocked(db.query.organization.findFirst).mockResolvedValue(
			organization as never,
		);
		polarMocks.getPolarClient.mockReturnValue({
			subscriptions: {
				get: polarMocks.subscriptionGet,
				update: polarMocks.subscriptionUpdate,
			},
			products: { get: polarMocks.productGet },
			orders: { list: polarMocks.ordersList },
		} as never);
		polarMocks.productGet.mockResolvedValue({
			prices: [{ amount_type: "seat_based" }],
		});
		polarMocks.getCustomerState.mockResolvedValue({ id: "customer-state" });
		polarMocks.synchronizeCustomerState.mockResolvedValue({
			organizationId: "organization-1",
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		vi.unstubAllEnvs();
	});

	it("rejects a subscription owned by another external customer", async () => {
		polarMocks.subscriptionGet.mockResolvedValue({
			id: "subscription-1",
			customer: { external_id: "organization-2" },
			status: "active",
			product_id: "product-old",
			seats: 2,
		});

		await expect(
			caller().changeSubscription({
				tier: "hobby",
				serverQuantity: 5,
				isAnnual: false,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(polarMocks.subscriptionUpdate).not.toHaveBeenCalled();
	});

	it("prorates product and seat changes, then synchronizes local access", async () => {
		const current = {
			id: "subscription-1",
			customer: { external_id: "organization-1" },
			status: "active",
			product_id: "product-old",
			seats: 2,
		};
		polarMocks.subscriptionGet.mockResolvedValue(current);
		polarMocks.subscriptionUpdate
			.mockResolvedValueOnce({
				...current,
				product_id: "product-hobby-monthly",
			})
			.mockResolvedValueOnce({
				...current,
				product_id: "product-hobby-monthly",
				seats: 5,
			});

		await expect(
			caller().changeSubscription({
				tier: "hobby",
				serverQuantity: 5,
				isAnnual: false,
			}),
		).resolves.toEqual({
			id: "subscription-1",
			status: "active",
			productId: "product-hobby-monthly",
			seats: 5,
		});
		expect(polarMocks.subscriptionUpdate).toHaveBeenNthCalledWith(
			1,
			"subscription-1",
			{
				product_id: "product-hobby-monthly",
				proration_behavior: "prorate",
			},
		);
		expect(polarMocks.subscriptionUpdate).toHaveBeenNthCalledWith(
			2,
			"subscription-1",
			{ seats: 5, proration_behavior: "prorate" },
		);
		expect(polarMocks.synchronizeCustomerState).toHaveBeenCalledWith(
			{ id: "customer-state" },
			{
				seatOverride: { subscriptionId: "subscription-1", seats: 5 },
			},
		);
	});

	it("returns no orders without a synchronized Polar customer", async () => {
		vi.mocked(db.query.organization.findFirst).mockResolvedValue({
			...organization,
			polarCustomerId: null,
		} as never);
		vi.stubEnv("POLAR_ACCESS_TOKEN", "polar_oat_abcdefghijklmnop");

		await expect(caller().getOrders()).resolves.toEqual([]);
		expect(polarMocks.getPolarClient).not.toHaveBeenCalled();
		expect(polarMocks.ordersList).not.toHaveBeenCalled();
	});
});
