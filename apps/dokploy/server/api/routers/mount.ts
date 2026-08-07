import {
	createMount,
	deleteMount,
	findApplicationById,
	findComposeById,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMountById,
	findMountsByApplicationId,
	findMySqlById,
	findPostgresById,
	findRedisById,
	getServiceContainer,
	IS_MANAGED_PAAS,
	updateMount,
} from "@dokploy/server";
import type { ServiceType } from "@dokploy/server/db/schema/mount";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateMount,
	apiFindMountByApplicationId,
	apiFindOneMount,
	apiRemoveMount,
	apiUpdateMount,
} from "@/server/db/schema";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const createMountInput = IS_MANAGED_PAAS
	? apiCreateMount.extend({ serviceType: z.literal("application") })
	: apiCreateMount;
const updateMountInput = IS_MANAGED_PAAS
	? apiUpdateMount
			.omit({
				composeId: true,
				libsqlId: true,
				mariadbId: true,
				mongoId: true,
				mysqlId: true,
				postgresId: true,
				redisId: true,
			})
			.extend({ serviceType: z.literal("application").optional() })
	: apiUpdateMount;
const listMountsInput = IS_MANAGED_PAAS
	? z.object({
			serviceType: z.literal("application"),
			serviceId: z.string().min(1),
		})
	: apiFindMountByApplicationId;

const assertManagedMountSafety = (input: {
	type?: "bind" | "volume" | "file";
	hostPath?: string | null;
	volumeName?: string | null;
	filePath?: string | null;
	content?: string | null;
}) => {
	if (!IS_MANAGED_PAAS) return;
	if (input.type === "bind" || input.hostPath !== undefined) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Host bind mounts are not available on managed compute",
		});
	}
	if (input.volumeName !== undefined) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Volume names are managed by the platform",
		});
	}

	if (input.filePath !== undefined) {
		const normalizedPath = (input.filePath ?? "").replaceAll("\\", "/");
		if (
			normalizedPath.startsWith("/") ||
			normalizedPath.split("/").includes("..")
		) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "File mount path must stay inside the workload directory",
			});
		}
	}

	const configuredMaxContentBytes = Number.parseInt(
		process.env.PLATFORM_MAX_FILE_MOUNT_BYTES || String(1024 * 1024),
		10,
	);
	const maxContentBytes =
		Number.isSafeInteger(configuredMaxContentBytes) &&
		configuredMaxContentBytes > 0
			? configuredMaxContentBytes
			: 1024 * 1024;
	if (
		input.content !== undefined &&
		Buffer.byteLength(input.content ?? "", "utf8") > maxContentBytes
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "File mount exceeds the managed plan limit",
		});
	}
};

async function getServiceOrganizationId(
	serviceId: string,
	serviceType: ServiceType,
): Promise<string | null> {
	switch (serviceType) {
		case "application": {
			const app = await findApplicationById(serviceId);
			return app?.environment?.project?.organizationId ?? null;
		}
		case "postgres": {
			const postgres = await findPostgresById(serviceId);
			return postgres?.environment?.project?.organizationId ?? null;
		}
		case "mariadb": {
			const mariadb = await findMariadbById(serviceId);
			return mariadb?.environment?.project?.organizationId ?? null;
		}
		case "mongo": {
			const mongo = await findMongoById(serviceId);
			return mongo?.environment?.project?.organizationId ?? null;
		}
		case "mysql": {
			const mysql = await findMySqlById(serviceId);
			return mysql?.environment?.project?.organizationId ?? null;
		}
		case "redis": {
			const redis = await findRedisById(serviceId);
			return redis?.environment?.project?.organizationId ?? null;
		}
		case "compose": {
			const compose = await findComposeById(serviceId);
			return compose?.environment?.project?.organizationId ?? null;
		}
		case "libsql": {
			const libsql = await findLibsqlById(serviceId);
			return libsql?.environment?.project?.organizationId ?? null;
		}
		default:
			return null;
	}
}

export const mountRouter = createTRPCRouter({
	create: protectedProcedure
		.input(createMountInput)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				volume: ["create"],
			});
			assertManagedMountSafety(input);
			const mount = await createMount(input);
			await audit(ctx, {
				action: "create",
				resourceType: "mount",
				resourceId: mount.mountId,
				resourceName: input.mountPath,
			});
			return mount;
		}),
	remove: protectedProcedure
		.input(apiRemoveMount)
		.mutation(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["delete"],
				});
			}
			await audit(ctx, {
				action: "delete",
				resourceType: "mount",
				resourceId: input.mountId,
			});
			return await deleteMount(input.mountId);
		}),

	one: protectedProcedure
		.input(apiFindOneMount)
		.query(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["read"],
				});
			}
			return mount;
		}),
	update: protectedProcedure
		.input(updateMountInput)
		.mutation(async ({ input, ctx }) => {
			const mount = await findMountById(input.mountId);
			const serviceId =
				mount.applicationId ||
				mount.postgresId ||
				mount.mariadbId ||
				mount.mongoId ||
				mount.mysqlId ||
				mount.redisId ||
				mount.libsqlId ||
				mount.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volume: ["create"],
				});
			}
			assertManagedMountSafety({
				...input,
				type: input.type ?? mount.type,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "mount",
				resourceId: input.mountId,
				resourceName: input.mountPath,
			});
			return await updateMount(input.mountId, input);
		}),
	allNamedByApplicationId: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				volume: ["read"],
			});
			const app = await findApplicationById(input.applicationId);
			const container = await getServiceContainer(app.appName, app.serverId);
			const mounts = container?.Mounts.filter(
				(mount) => mount.Type === "volume" && mount.Source !== "",
			);
			return mounts;
		}),
	listByServiceId: protectedProcedure
		.input(listMountsInput)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.serviceId, "read");
			const organizationId = await getServiceOrganizationId(
				input.serviceId,
				input.serviceType,
			);
			if (
				organizationId === null ||
				organizationId !== ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message:
						"You are not authorized to access this service or it does not exist",
				});
			}
			return await findMountsByApplicationId(
				input.serviceId,
				input.serviceType,
			);
		}),
});
