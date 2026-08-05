import {
	containerKill,
	containerRemove,
	containerRestart,
	containerStart,
	containerStop,
	findServerById,
	getConfig,
	getContainers,
	getContainersByAppLabel,
	getContainersByAppNameMatch,
	getServiceContainersByAppName,
	getStackContainersByAppName,
	IS_MANAGED_PAAS,
	isPlatformAdmin,
	resolveManagedServiceExecutionTarget,
	uploadFileToContainer,
} from "@dokploy/server";
import { checkServiceAccess } from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { uploadFileToContainerSchema } from "@/utils/schema";
import { createTRPCRouter, withPermission } from "../trpc";

export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

type DockerRequestContext = {
	user: { id: string };
	session: { activeOrganizationId: string };
};

const authorizeDockerTarget = async (
	ctx: DockerRequestContext,
	input: { serverId?: string; serviceId?: string },
) => {
	if (IS_MANAGED_PAAS && input.serviceId) {
		await checkServiceAccess(ctx, input.serviceId, "read");
		const target = await resolveManagedServiceExecutionTarget(
			input.serviceId,
			ctx.session.activeOrganizationId,
		);
		if (target.runtime !== "swarm") {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Direct container access is unavailable for managed runtimes",
			});
		}
		return target;
	}

	if (IS_MANAGED_PAAS && !(await isPlatformAdmin(ctx.user.id))) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Direct container access is managed by the platform",
		});
	}

	if (input.serverId) {
		const targetServer = await findServerById(input.serverId);
		if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
	}

	return {
		serverId: input.serverId,
		appName: undefined,
	};
};

export const dockerRouter = createTRPCRouter({
	getContainers: withPermission("docker", "read")
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			return await getContainers(input.serverId);
		}),

	restartContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			await containerRestart(input.containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	startContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			await containerStart(input.containerId, input.serverId);
			await audit(ctx, {
				action: "start",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	stopContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			await containerStop(input.containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	killContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			await containerKill(input.containerId, input.serverId);
			await audit(ctx, {
				action: "stop",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	removeContainer: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			await containerRemove(input.containerId, input.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "docker",
				resourceId: input.containerId,
				resourceName: input.containerId,
			});
		}),

	getConfig: withPermission("docker", "read")
		.input(
			z.object({
				containerId: z
					.string()
					.min(1)
					.regex(containerIdRegex, "Invalid container id."),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			return await getConfig(input.containerId, input.serverId);
		}),

	getContainersByAppNameMatch: withPermission("service", "read")
		.input(
			z.object({
				appType: z.enum(["stack", "docker-compose"]).optional(),
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				serviceId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const target = await authorizeDockerTarget(ctx, input);
			return await getContainersByAppNameMatch(
				target.appName || input.appName,
				input.appType,
				target.serverId,
			);
		}),

	getContainersByAppLabel: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				type: z.enum(["standalone", "swarm"]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);
			return await getContainersByAppLabel(
				input.appName,
				input.type,
				input.serverId,
			);
		}),

	getStackContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				serviceId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const target = await authorizeDockerTarget(ctx, input);
			return await getStackContainersByAppName(
				target.appName || input.appName,
				target.serverId,
			);
		}),

	getServiceContainersByAppName: withPermission("docker", "read")
		.input(
			z.object({
				appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
				serverId: z.string().optional(),
				serviceId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			const target = await authorizeDockerTarget(ctx, input);
			return await getServiceContainersByAppName(
				target.appName || input.appName,
				target.serverId,
			);
		}),

	uploadFileToContainer: withPermission("docker", "read")
		.input(uploadFileToContainerSchema)
		.mutation(async ({ input, ctx }) => {
			await authorizeDockerTarget(ctx, input);

			const file = input.file;
			if (!(file instanceof File)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Invalid file provided",
				});
			}

			// Convert File to Buffer
			const arrayBuffer = await file.arrayBuffer();
			const fileBuffer = Buffer.from(arrayBuffer);

			await uploadFileToContainer(
				input.containerId,
				fileBuffer,
				file.name,
				input.destinationPath,
				input.serverId || null,
			);

			return { success: true, message: "File uploaded successfully" };
		}),
});
