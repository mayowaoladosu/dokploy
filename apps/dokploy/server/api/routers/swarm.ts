import {
	findServerById,
	getAllContainerStats,
	getApplicationInfo,
	getNodeApplications,
	getNodeInfo,
	getSwarmNodes,
	IS_MANAGED_PAAS,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	platformAdminProcedure,
	withPermission,
} from "../trpc";
import { containerIdRegex } from "./docker";

export const swarmRouter = createTRPCRouter({
	getNodes: (IS_MANAGED_PAAS
		? platformAdminProcedure
		: withPermission("server", "read")
	)
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			}
			return await getSwarmNodes(input.serverId);
		}),
	getNodeInfo: (IS_MANAGED_PAAS
		? platformAdminProcedure
		: withPermission("server", "read")
	)
		.input(z.object({ nodeId: z.string(), serverId: z.string().optional() }))
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			}
			return await getNodeInfo(input.nodeId, input.serverId);
		}),
	getNodeApps: (IS_MANAGED_PAAS
		? platformAdminProcedure
		: withPermission("server", "read")
	)
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			}
			return getNodeApplications(input.serverId);
		}),
	getAppInfos: (IS_MANAGED_PAAS
		? platformAdminProcedure
		: withPermission("server", "read")
	)
		.meta({
			openapi: {
				path: "/drop-deployment",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z.object({
				appName: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid app name.")
					.array(),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}
			}
			return await getApplicationInfo(input.appName, input.serverId);
		}),
	getContainerStats: (IS_MANAGED_PAAS
		? platformAdminProcedure
		: withPermission("server", "read")
	)
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			if (input.serverId) {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}
			return await getAllContainerStats(input.serverId);
		}),
});
