import {
	getUsageTotal,
	upsertUsageQuota,
	usageWindowStart,
} from "@dokploy/server/services/usage-metering";
import { z } from "zod";
import {
	createTRPCRouter,
	platformAdminProcedure,
	protectedProcedure,
} from "../trpc";

const metric = z.enum([
	"build_seconds",
	"cpu_milliseconds",
	"memory_byte_seconds",
	"request_count",
	"egress_bytes",
	"storage_byte_hours",
]);

export const usageRouter = createTRPCRouter({
	summary: protectedProcedure
		.input(
			z.object({
				metric,
				window: z.enum(["hour", "day", "month"]).default("month"),
			}),
		)
		.query(async ({ ctx, input }) => ({
			metric: input.metric,
			window: input.window,
			quantity: (
				await getUsageTotal({
					organizationId: ctx.session.activeOrganizationId,
					metric: input.metric,
					from: usageWindowStart(input.window),
				})
			).toString(),
		})),
	upsertQuota: platformAdminProcedure
		.input(
			z.object({
				organizationId: z.string().min(1),
				metric,
				window: z.enum(["hour", "day", "month"]),
				limitQuantity: z.string().regex(/^\d+$/),
				action: z.enum(["warn", "block", "throttle"]).optional(),
				enabled: z.boolean().optional(),
				metadata: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.mutation(({ input }) => upsertUsageQuota(input)),
});
