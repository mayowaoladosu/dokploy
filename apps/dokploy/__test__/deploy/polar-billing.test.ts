import type { models } from "@polar-sh/sdk/2026-04";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	resolvePolarCustomerBillingState,
	verifyPolarConfiguration,
} from "@/server/utils/polar";

const customerState = ({
	productId = "product-hobby-monthly",
	metadata = {},
	externalId = "organization-1",
}: {
	productId?: string;
	metadata?: Record<string, unknown>;
	externalId?: string | null;
} = {}) =>
	({
		id: "polar-customer-1",
		external_id: externalId,
		organization_id: "polar-organization-1",
		active_subscriptions: [
			{
				id: "subscription-1",
				product_id: productId,
				status: "active",
				metadata,
				current_period_end: "2026-09-01T00:00:00.000Z",
			},
		],
	}) as unknown as models.CustomerState;

describe("Polar Customer State billing projection", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("maps a configured subscription and its checkout capacity", () => {
		vi.stubEnv("POLAR_HOBBY_MONTHLY_PRODUCT_ID", "product-hobby-monthly");

		const resolved = resolvePolarCustomerBillingState(
			customerState({ metadata: { serverQuantity: 4 } }),
		);

		expect(resolved).toMatchObject({
			externalCustomerId: "organization-1",
			plan: "hobby",
			billingSeats: 4,
			organizationState: {
				polarCustomerId: "polar-customer-1",
				polarSubscriptionId: "subscription-1",
				billingPlan: "hobby",
				billingStatus: "active",
				billingSeats: 4,
			},
		});
		expect(resolved?.organizationState.billingCurrentPeriodEnd).toEqual(
			new Date("2026-09-01T00:00:00.000Z"),
		);
	});

	it("uses an authoritative subscription event seat count over stale metadata", () => {
		vi.stubEnv("POLAR_HOBBY_MONTHLY_PRODUCT_ID", "product-hobby-monthly");

		const resolved = resolvePolarCustomerBillingState(
			customerState({ metadata: { serverQuantity: 2 } }),
			{ polarSubscriptionId: "subscription-1", billingSeats: 2 },
			{ subscriptionId: "subscription-1", seats: 7 },
		);

		expect(resolved?.billingSeats).toBe(7);
	});

	it("preserves the last authoritative seats across repeated state events", () => {
		vi.stubEnv("POLAR_STARTUP_MONTHLY_PRODUCT_ID", "product-hobby-monthly");

		const resolved = resolvePolarCustomerBillingState(customerState(), {
			polarSubscriptionId: "subscription-1",
			billingSeats: 9,
		});

		expect(resolved?.plan).toBe("startup");
		expect(resolved?.billingSeats).toBe(9);
	});

	it("ignores unrelated products and customers without an external identity", () => {
		vi.stubEnv("POLAR_HOBBY_MONTHLY_PRODUCT_ID", "configured-product");

		expect(resolvePolarCustomerBillingState(customerState())).toMatchObject({
			plan: null,
			billingSeats: 0,
			organizationState: {
				polarSubscriptionId: null,
				billingStatus: null,
			},
		});
		expect(
			resolvePolarCustomerBillingState(customerState({ externalId: null })),
		).toBeNull();
	});

	it("accepts one base price alongside metered usage prices", async () => {
		vi.stubEnv("POLAR_ORGANIZATION_ID", "polar-organization-1");
		vi.stubEnv("POLAR_HOBBY_MONTHLY_PRODUCT_ID", "product-hobby-monthly");
		vi.stubEnv("POLAR_USAGE_CUTOVER_AT", "2026-08-06T00:00:00.000Z");
		const polar = {
			organizations: {
				get: vi.fn(async () => ({ id: "polar-organization-1" })),
			},
			products: {
				get: vi.fn(async () => ({
					id: "product-hobby-monthly",
					organization_id: "polar-organization-1",
					is_archived: false,
					recurring_interval: "month",
					prices: [
						{ is_archived: false, amount_type: "fixed" },
						{
							is_archived: false,
							amount_type: "metered_unit",
							meter_id: "meter-build-seconds",
						},
					],
				})),
			},
		} as never;

		await expect(verifyPolarConfiguration(polar)).resolves.toBe(true);
	});
});
