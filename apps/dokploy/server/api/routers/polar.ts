import {
	findUserById,
	IS_HOSTED,
	IS_MANAGED_PAAS,
	updateUser,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { organization, server } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { count, eq } from "drizzle-orm";
import { z } from "zod";
import {
	BILLING_SITE_URL,
	billingIntervalForProduct,
	billingPlanForProduct,
	billingProductFor,
	getPolarClient,
	getPolarCustomerState,
	isPolarNotFound,
	polarProductCatalog,
	synchronizePolarCustomerState,
} from "@/server/utils/polar";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "../trpc";

const billingUrl = () => {
	if (!BILLING_SITE_URL) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Billing URL is not configured",
		});
	}
	return `${BILLING_SITE_URL.replace(/\/$/, "")}/dashboard/settings/billing`;
};

const connectingIp = (
	headers: Record<string, string | string[] | undefined>,
) => {
	const value =
		headers["cf-connecting-ip"] ||
		headers["true-client-ip"] ||
		headers["x-forwarded-for"];
	const first = Array.isArray(value) ? value[0] : value?.split(",")[0];
	return first?.trim() || undefined;
};

const activeOrganization = async (organizationId: string) => {
	const result = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Organization not found",
		});
	}
	return result;
};

const ownedOrganization = async (organizationId: string, userId: string) => {
	const result = await activeOrganization(organizationId);
	if (result.ownerId !== userId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Only the organization owner can manage billing",
		});
	}
	return result;
};

export const polarRouter = createTRPCRouter({
	getCurrentPlan: protectedProcedure.query(async ({ ctx }) => {
		if (!IS_HOSTED) return null;
		const current = await activeOrganization(ctx.session.activeOrganizationId);
		return current.billingStatus === "active" ||
			current.billingStatus === "trialing"
			? (current.billingPlan as "legacy" | "hobby" | "startup" | null)
			: null;
	}),

	getBillingOverview: adminProcedure.query(async ({ ctx }) => {
		const localOrganization = await ownedOrganization(
			ctx.session.activeOrganizationId,
			ctx.user.id,
		);
		const owner = await findUserById(localOrganization.ownerId);
		if (!process.env.POLAR_ACCESS_TOKEN?.trim()) {
			return {
				configured: false,
				products: [],
				subscription: null,
				currentPlan: null,
				hasCustomer: false,
				managed: IS_MANAGED_PAAS,
				isEnterpriseCloud: owner.isEnterpriseCloud,
				invoiceNotifications: owner.sendInvoiceNotifications,
			};
		}

		const polar = getPolarClient();
		const [products, customerState] = await Promise.all([
			polarProductCatalog(polar),
			getPolarCustomerState(localOrganization.id, polar),
		]);
		const synchronized = customerState
			? await synchronizePolarCustomerState(customerState)
			: null;
		const subscription = synchronized?.subscription ?? null;
		return {
			configured: true,
			products,
			subscription: subscription
				? {
						id: subscription.id,
						status: subscription.status,
						productId: subscription.product_id,
						amount: subscription.amount,
						currency: subscription.currency,
						currentPeriodEnd: subscription.current_period_end,
						cancelAtPeriodEnd: subscription.cancel_at_period_end,
						seats: synchronized?.billingSeats ?? 0,
						interval:
							billingIntervalForProduct(subscription.product_id) ||
							subscription.recurring_interval,
					}
				: null,
			currentPlan: subscription
				? billingPlanForProduct(subscription.product_id)
				: null,
			hasCustomer: Boolean(customerState),
			managed: IS_MANAGED_PAAS,
			isEnterpriseCloud: owner.isEnterpriseCloud,
			invoiceNotifications: owner.sendInvoiceNotifications,
		};
	}),

	createCheckoutSession: adminProcedure
		.input(
			z
				.object({
					tier: z.enum(["legacy", "hobby", "startup"]),
					serverQuantity: z.number().int().min(1).max(1_000),
					isAnnual: z.boolean(),
				})
				.refine(
					(data) =>
						IS_MANAGED_PAAS ||
						data.tier !== "startup" ||
						data.serverQuantity >= 3,
					{
						message: "Startup plan requires at least 3 servers",
						path: ["serverQuantity"],
					},
				),
		)
		.mutation(async ({ ctx, input }) => {
			const localOrganization = await ownedOrganization(
				ctx.session.activeOrganizationId,
				ctx.user.id,
			);
			const owner = await findUserById(localOrganization.ownerId);
			if (owner.isEnterpriseCloud) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Enterprise billing is managed by the vlyv team",
				});
			}
			const product = billingProductFor(input.tier, input.isAnnual);
			const polar = getPolarClient();
			const customerState = await getPolarCustomerState(
				localOrganization.id,
				polar,
			);
			if (customerState) {
				const synchronized = await synchronizePolarCustomerState(customerState);
				if (synchronized?.subscription) {
					throw new TRPCError({
						code: "CONFLICT",
						message:
							"This organization already has an active subscription; update it instead",
					});
				}
			}
			const polarProduct = await polar.products.get(product.productId);
			const supportsSeats = polarProduct.prices.some(
				(price) => price.amount_type === "seat_based",
			);
			const serverQuantity = IS_MANAGED_PAAS ? 1 : input.serverQuantity;
			const checkout = await polar.checkouts.create({
				products: [product.productId],
				...(supportsSeats ? { seats: serverQuantity } : {}),
				external_customer_id: localOrganization.id,
				customer_email: owner.email,
				customer_name: localOrganization.name,
				customer_ip_address: connectingIp(ctx.req.headers),
				require_billing_address: true,
				allow_discount_codes: true,
				success_url: `${billingUrl()}?success=true&checkout_id={CHECKOUT_ID}`,
				return_url: billingUrl(),
				metadata: {
					organizationId: localOrganization.id,
					ownerId: localOrganization.ownerId,
					tier: input.tier,
					serverQuantity,
				},
				customer_metadata: {
					organizationId: localOrganization.id,
				},
			});
			return { url: checkout.url };
		}),

	createCustomerPortalSession: adminProcedure.mutation(async ({ ctx }) => {
		const localOrganization = await ownedOrganization(
			ctx.session.activeOrganizationId,
			ctx.user.id,
		);
		try {
			const session = await getPolarClient().customerSessions.create({
				external_customer_id: localOrganization.id,
				return_url: billingUrl(),
			});
			return { url: session.customer_portal_url };
		} catch (error) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Polar customer portal is not available for this organization",
				cause: error,
			});
		}
	}),

	changeSubscription: adminProcedure
		.input(
			z
				.object({
					tier: z.enum(["legacy", "hobby", "startup"]),
					serverQuantity: z.number().int().min(1).max(1_000),
					isAnnual: z.boolean(),
				})
				.refine(
					(data) =>
						IS_MANAGED_PAAS ||
						data.tier !== "startup" ||
						data.serverQuantity >= 3,
					{
						message: "Startup plan requires at least 3 servers",
						path: ["serverQuantity"],
					},
				),
		)
		.mutation(async ({ ctx, input }) => {
			const localOrganization = await ownedOrganization(
				ctx.session.activeOrganizationId,
				ctx.user.id,
			);
			const owner = await findUserById(localOrganization.ownerId);
			if (owner.isEnterpriseCloud) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Enterprise billing is managed by the vlyv team",
				});
			}
			if (!localOrganization.polarSubscriptionId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "No active Polar subscription was found",
				});
			}
			const polar = getPolarClient();
			const current = await polar.subscriptions.get(
				localOrganization.polarSubscriptionId,
			);
			if (
				current.customer.external_id !== localOrganization.id ||
				!(current.status === "active" || current.status === "trialing")
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The Polar subscription cannot be changed",
				});
			}
			const product = billingProductFor(input.tier, input.isAnnual);
			const serverQuantity = IS_MANAGED_PAAS ? 1 : input.serverQuantity;
			let updated = current;
			if (current.product_id !== product.productId) {
				updated = await polar.subscriptions.update(current.id, {
					product_id: product.productId,
					proration_behavior: "prorate",
				});
			}
			const targetProduct = await polar.products.get(product.productId);
			const supportsSeats = targetProduct.prices.some(
				(price) => price.amount_type === "seat_based",
			);
			if (supportsSeats && updated.seats !== serverQuantity) {
				updated = await polar.subscriptions.update(current.id, {
					seats: serverQuantity,
					proration_behavior: "prorate",
				});
			}
			const customerState = await getPolarCustomerState(
				localOrganization.id,
				polar,
			);
			if (customerState) {
				await synchronizePolarCustomerState(customerState, {
					seatOverride: {
						subscriptionId: updated.id,
						seats: updated.seats ?? serverQuantity,
					},
				});
			}
			return {
				id: updated.id,
				status: updated.status,
				productId: updated.product_id,
				seats: updated.seats ?? serverQuantity,
			};
		}),

	canCreateMoreServers: withPermission("server", "create").query(
		async ({ ctx }) => {
			if (!IS_HOSTED || IS_MANAGED_PAAS) return true;
			const localOrganization = await activeOrganization(
				ctx.session.activeOrganizationId,
			);
			const [usage] = await db
				.select({ total: count() })
				.from(server)
				.where(eq(server.organizationId, localOrganization.id));
			return (usage?.total ?? 0) < localOrganization.billingSeats;
		},
	),

	updateInvoiceNotifications: adminProcedure
		.input(z.object({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			if (!IS_HOSTED) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Billing notifications are only available in hosted mode",
				});
			}
			await ownedOrganization(ctx.session.activeOrganizationId, ctx.user.id);
			await updateUser(ctx.user.id, {
				sendInvoiceNotifications: input.enabled,
			});
			return { ok: true };
		}),

	getOrders: adminProcedure.query(async ({ ctx }) => {
		const localOrganization = await ownedOrganization(
			ctx.session.activeOrganizationId,
			ctx.user.id,
		);
		if (
			!process.env.POLAR_ACCESS_TOKEN?.trim() ||
			!localOrganization.polarCustomerId
		) {
			return [];
		}
		const polar = getPolarClient();
		const response = await polar.orders
			.list({
				external_customer_id: localOrganization.id,
				limit: 50,
				sorting: ["-created_at"],
			})
			.catch((error) => {
				if (isPolarNotFound(error)) return null;
				throw error;
			});
		if (!response) return [];
		return Promise.all(
			response.items.map(async (order) => {
				const [invoice, receipt] = await Promise.all([
					order.is_invoice_generated
						? polar.orders.invoice(order.id).catch(() => null)
						: Promise.resolve(null),
					order.receipt_number
						? polar.orders.receipt(order.id).catch(() => null)
						: Promise.resolve(null),
				]);
				return {
					id: order.id,
					number: order.invoice_number || order.receipt_number,
					status: order.status,
					amountDue: order.due_amount,
					amountPaid: Math.max(order.total_amount - order.due_amount, 0),
					totalAmount: order.total_amount,
					currency: order.currency,
					createdAt: order.created_at,
					invoiceUrl: invoice?.url ?? null,
					receiptUrl: receipt?.url ?? null,
				};
			}),
		);
	}),
});
