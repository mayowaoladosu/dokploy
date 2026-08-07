import { IS_HOSTED } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { organization } from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

export type BillingPlan = "legacy" | "hobby" | "startup";
const billingPlanRank: Record<BillingPlan, number> = {
	legacy: 3,
	startup: 2,
	hobby: 1,
};

export const getCurrentPlanForUser = async (
	userId: string,
): Promise<BillingPlan | null> => {
	if (!IS_HOSTED) return null;
	const owned = await db.query.organization.findMany({
		where: eq(organization.ownerId, userId),
		columns: {
			billingPlan: true,
			billingStatus: true,
			billingCurrentPeriodEnd: true,
			billingLastSyncedAt: true,
		},
	});
	const now = Date.now();
	const activePlans = owned.flatMap((entry) => {
		if (
			!(
				entry.billingStatus === "active" || entry.billingStatus === "trialing"
			) ||
			!entry.billingLastSyncedAt ||
			now - entry.billingLastSyncedAt.getTime() > 24 * 60 * 60 * 1_000 ||
			(entry.billingCurrentPeriodEnd !== null &&
				entry.billingCurrentPeriodEnd.getTime() < now) ||
			!entry.billingPlan
		) {
			return [];
		}
		return [entry.billingPlan as BillingPlan];
	});
	return (
		activePlans.sort(
			(left, right) => billingPlanRank[right] - billingPlanRank[left],
		)[0] ?? null
	);
};

export const getCurrentPlan = async (
	organizationId: string,
): Promise<BillingPlan | null> => {
	if (!IS_HOSTED) return null;
	const current = await db.query.organization.findFirst({
		where: eq(organization.id, organizationId),
		columns: {
			billingPlan: true,
			billingStatus: true,
			billingCurrentPeriodEnd: true,
			billingLastSyncedAt: true,
		},
	});
	const now = Date.now();
	if (
		!current ||
		!(
			current.billingStatus === "active" || current.billingStatus === "trialing"
		) ||
		!current.billingLastSyncedAt ||
		now - current.billingLastSyncedAt.getTime() > 24 * 60 * 60 * 1_000 ||
		(current.billingCurrentPeriodEnd !== null &&
			current.billingCurrentPeriodEnd.getTime() < now)
	) {
		return null;
	}
	return current.billingPlan as BillingPlan | null;
};

export const assertBillingEntitlement = async (organizationId: string) => {
	if (!IS_HOSTED) return;
	if (!(await getCurrentPlan(organizationId))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "An active subscription is required for this action.",
		});
	}
};
