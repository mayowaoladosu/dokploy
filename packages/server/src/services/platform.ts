import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	applications,
	compose,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	redis,
	server,
	user,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";

export type ManagedComputeKind = "application" | "service";

export type ManagedComputeCandidate = {
	serverId: string;
	serverType: "deploy" | "build";
	workloadCount: number;
	buildsConcurrency: number;
};

export type ManagedComputeAssignment = {
	serverId?: string;
	buildServerId?: string;
	registryId?: string;
	buildRegistryId?: string;
	rollbackRegistryId?: string;
};

const configuredPlatformAdminIds = () =>
	new Set(
		[
			process.env.USER_ADMIN_ID,
			...(process.env.PLATFORM_ADMIN_USER_IDS?.split(",") ?? []),
		]
			.map((id) => id?.trim())
			.filter((id): id is string => Boolean(id)),
	);

const configuredPlatformAdminEmails = () =>
	new Set(
		(process.env.PLATFORM_ADMIN_EMAILS?.split(",") ?? [])
			.map((email) => email.trim().toLowerCase())
			.filter(Boolean),
	);

export const isPlatformAdminIdentity = (
	platformUser:
		| { id: string; email?: string | null; role: string | null }
		| null
		| undefined,
	configuredIds: ReadonlySet<string> = configuredPlatformAdminIds(),
	configuredEmails: ReadonlySet<string> = configuredPlatformAdminEmails(),
) =>
	Boolean(
		platformUser &&
			(platformUser.role === "admin" ||
				configuredIds.has(platformUser.id) ||
				(platformUser.email &&
					configuredEmails.has(platformUser.email.toLowerCase()))),
	);

export const isPlatformAdmin = async (userId: string) => {
	const platformUser = await db.query.user.findFirst({
		where: eq(user.id, userId),
		columns: { id: true, email: true, role: true },
	});

	return isPlatformAdminIdentity(platformUser);
};

/**
 * Makes the first account on a new managed installation the platform admin.
 * Organization roles are deliberately not used here: every customer owns
 * their organization, while only this global role may operate infrastructure.
 */
export const ensureBootstrapPlatformAdmin = async (
	userId: string,
	email?: string | null,
) => {
	if (!IS_MANAGED_PAAS) return false;

	const configuredIds = configuredPlatformAdminIds();
	const configuredEmails = configuredPlatformAdminEmails();
	if (
		configuredIds.has(userId) ||
		(email && configuredEmails.has(email.toLowerCase()))
	) {
		await db.update(user).set({ role: "admin" }).where(eq(user.id, userId));
		return true;
	}

	const existingAdmin = await db.query.user.findFirst({
		where: eq(user.role, "admin"),
		columns: { id: true },
	});
	if (existingAdmin) return existingAdmin.id === userId;
	if (process.env.NODE_ENV === "production") return false;

	const firstUser = await db.query.user.findFirst({
		columns: { id: true },
		orderBy: [asc(user.createdAt2)],
	});
	if (firstUser?.id !== userId) return false;

	await db.update(user).set({ role: "admin" }).where(eq(user.id, userId));
	return true;
};

export const assertManagedPlatformConfiguration = () => {
	if (
		IS_MANAGED_PAAS &&
		process.env.NODE_ENV === "production" &&
		configuredPlatformAdminIds().size === 0 &&
		configuredPlatformAdminEmails().size === 0
	) {
		throw new Error(
			"Managed mode requires USER_ADMIN_ID, PLATFORM_ADMIN_USER_IDS, or PLATFORM_ADMIN_EMAILS",
		);
	}
	if (
		IS_MANAGED_PAAS &&
		process.env.NODE_ENV === "production" &&
		!process.env.PLATFORM_APPS_DOMAIN?.trim()
	) {
		throw new Error("Managed mode requires PLATFORM_APPS_DOMAIN");
	}
	if (
		IS_MANAGED_PAAS &&
		process.env.NODE_ENV === "production" &&
		!process.env.PLATFORM_URL?.trim() &&
		!process.env.BETTER_AUTH_URL?.trim()
	) {
		throw new Error("Managed mode requires PLATFORM_URL or BETTER_AUTH_URL");
	}
};

export const getManagedApplicationDomain = (
	appName: string,
	baseDomainInput = process.env.PLATFORM_APPS_DOMAIN,
	managed = IS_MANAGED_PAAS,
) => {
	if (!managed) return null;
	const baseDomain = baseDomainInput
		?.trim()
		.toLowerCase()
		.replace(/^\*\./, "")
		.replace(/^\.+|\.+$/g, "");
	if (!baseDomain) return null;
	return `${appName}.${baseDomain}`;
};

export const assertNoManagedServerSelection = (
	requestedServerId: string | null | undefined,
	managed = IS_MANAGED_PAAS,
) => {
	if (managed && requestedServerId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "Compute placement is managed by the platform",
		});
	}
};

export const selectManagedComputeCandidate = (
	candidates: readonly ManagedComputeCandidate[],
	type: ManagedComputeCandidate["serverType"],
) =>
	candidates
		.filter((candidate) => candidate.serverType === type)
		.sort((left, right) => {
			const leftScore =
				type === "build"
					? left.workloadCount / Math.max(left.buildsConcurrency, 1)
					: left.workloadCount;
			const rightScore =
				type === "build"
					? right.workloadCount / Math.max(right.buildsConcurrency, 1)
					: right.workloadCount;

			return (
				leftScore - rightScore || left.serverId.localeCompare(right.serverId)
			);
		})[0];

const getManagedComputeCandidates = async (): Promise<
	ManagedComputeCandidate[]
> => {
	const configuredIds = configuredPlatformAdminIds();
	const configuredEmails = configuredPlatformAdminEmails();
	const nodes = await db.query.server.findMany({
		where: eq(server.serverStatus, "active"),
		columns: {
			serverId: true,
			serverType: true,
			buildsConcurrency: true,
			sshKeyId: true,
		},
		with: {
			organization: {
				columns: { ownerId: true },
				with: { owner: { columns: { id: true, email: true, role: true } } },
			},
			applications: { columns: { applicationId: true } },
			buildApplications: { columns: { applicationId: true } },
			buildDeployments: { columns: { status: true } },
			compose: { columns: { composeId: true } },
			libsql: { columns: { libsqlId: true } },
			redis: { columns: { redisId: true } },
			mariadb: { columns: { mariadbId: true } },
			mongo: { columns: { mongoId: true } },
			mysql: { columns: { mysqlId: true } },
			postgres: { columns: { postgresId: true } },
		},
	});

	return nodes
		.filter(
			(node) =>
				Boolean(node.sshKeyId) &&
				isPlatformAdminIdentity(
					node.organization.owner,
					configuredIds,
					configuredEmails,
				),
		)
		.map((node) => ({
			serverId: node.serverId,
			serverType: node.serverType,
			buildsConcurrency: node.buildsConcurrency,
			workloadCount:
				node.serverType === "build"
					? node.buildDeployments.filter(
							(deployment) => deployment.status === "running",
						).length
					: node.applications.length +
						node.compose.length +
						node.libsql.length +
						node.redis.length +
						node.mariadb.length +
						node.mongo.length +
						node.mysql.length +
						node.postgres.length,
		}));
};

const getManagedRegistryId = async () => {
	const configuredIds = configuredPlatformAdminIds();
	const configuredEmails = configuredPlatformAdminEmails();
	const registries = await db.query.registry.findMany({
		columns: { registryId: true },
		with: {
			organization: {
				columns: { ownerId: true },
				with: { owner: { columns: { id: true, email: true, role: true } } },
			},
		},
	});

	return registries
		.filter((entry) =>
			isPlatformAdminIdentity(
				entry.organization.owner,
				configuredIds,
				configuredEmails,
			),
		)
		.sort((left, right) => left.registryId.localeCompare(right.registryId))[0]
		?.registryId;
};

/**
 * Resolves platform-owned compute for a new workload. Callers do not need to
 * know where nodes come from or how they are balanced. In self-hosted mode the
 * requested server is preserved exactly.
 */
export const resolveManagedCompute = async ({
	requestedServerId,
	kind,
}: {
	requestedServerId?: string | null;
	kind: ManagedComputeKind;
}): Promise<ManagedComputeAssignment> => {
	if (!IS_MANAGED_PAAS) {
		return { serverId: requestedServerId || undefined };
	}

	const candidates = await getManagedComputeCandidates();
	const deployNode = selectManagedComputeCandidate(candidates, "deploy");
	if (!deployNode) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Managed compute is not ready. A platform administrator must add and activate a deployment node.",
		});
	}

	if (kind === "service") {
		return { serverId: deployNode.serverId };
	}

	const managedRegistryId = await getManagedRegistryId();
	const buildNode = managedRegistryId
		? selectManagedComputeCandidate(candidates, "build")
		: undefined;
	return {
		serverId: deployNode.serverId,
		buildServerId: buildNode?.serverId,
		registryId: managedRegistryId,
		buildRegistryId: managedRegistryId,
		rollbackRegistryId: managedRegistryId,
	};
};

export type ManagedServiceExecutionTarget = {
	serviceId: string;
	serverId: string;
	appName: string;
	organizationId: string;
};

type ManagedResourceValues = {
	memoryLimit?: string | null;
	memoryReservation?: string | null;
	cpuLimit?: string | null;
	cpuReservation?: string | null;
};

const positiveIntegerEnv = (name: string, fallback: number) => {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

export const getManagedResourceDefaults = (
	managed = IS_MANAGED_PAAS,
): ManagedResourceValues =>
	managed
		? {
				memoryLimit: String(
					positiveIntegerEnv(
						"PLATFORM_DEFAULT_MEMORY_LIMIT_BYTES",
						512 * 1024 * 1024,
					),
				),
				memoryReservation: String(
					positiveIntegerEnv(
						"PLATFORM_DEFAULT_MEMORY_RESERVATION_BYTES",
						128 * 1024 * 1024,
					),
				),
				cpuLimit: String(
					positiveIntegerEnv("PLATFORM_DEFAULT_CPU_LIMIT_NANO", 1_000_000_000),
				),
				cpuReservation: String(
					positiveIntegerEnv(
						"PLATFORM_DEFAULT_CPU_RESERVATION_NANO",
						250_000_000,
					),
				),
			}
		: {};

export const assertManagedResourceLimits = (
	resources: ManagedResourceValues,
	managed = IS_MANAGED_PAAS,
) => {
	if (!managed) return;

	const limits = {
		memoryLimit: positiveIntegerEnv(
			"PLATFORM_MAX_MEMORY_LIMIT_BYTES",
			2 * 1024 * 1024 * 1024,
		),
		memoryReservation: positiveIntegerEnv(
			"PLATFORM_MAX_MEMORY_LIMIT_BYTES",
			2 * 1024 * 1024 * 1024,
		),
		cpuLimit: positiveIntegerEnv("PLATFORM_MAX_CPU_LIMIT_NANO", 2_000_000_000),
		cpuReservation: positiveIntegerEnv(
			"PLATFORM_MAX_CPU_LIMIT_NANO",
			2_000_000_000,
		),
	} as const;

	for (const field of [
		"memoryLimit",
		"memoryReservation",
		"cpuLimit",
		"cpuReservation",
	] as const) {
		const rawValue = resources[field];
		if (rawValue === undefined) continue;
		const value = Number.parseInt(rawValue ?? "", 10);
		if (!Number.isSafeInteger(value) || value <= 0 || value > limits[field]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `${field} exceeds the managed plan limit`,
			});
		}
	}
};

/**
 * Maps a customer-visible service ID to its private execution target. This is
 * the only managed-mode seam that observability adapters should cross; callers
 * must never accept a node ID or app name supplied by a tenant.
 */
export const resolveManagedServiceExecutionTarget = async (
	serviceId: string,
	organizationId: string,
): Promise<ManagedServiceExecutionTarget> => {
	const [
		application,
		composeService,
		libsqlService,
		mariadbService,
		mongoService,
		mysqlService,
		postgresService,
		redisService,
	] = await Promise.all([
		db.query.applications.findFirst({
			where: eq(applications.applicationId, serviceId),
			columns: { applicationId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.compose.findFirst({
			where: eq(compose.composeId, serviceId),
			columns: { composeId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.libsql.findFirst({
			where: eq(libsql.libsqlId, serviceId),
			columns: { libsqlId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.mariadb.findFirst({
			where: eq(mariadb.mariadbId, serviceId),
			columns: { mariadbId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.mongo.findFirst({
			where: eq(mongo.mongoId, serviceId),
			columns: { mongoId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.mysql.findFirst({
			where: eq(mysql.mysqlId, serviceId),
			columns: { mysqlId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.postgres.findFirst({
			where: eq(postgres.postgresId, serviceId),
			columns: { postgresId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
		db.query.redis.findFirst({
			where: eq(redis.redisId, serviceId),
			columns: { redisId: true, appName: true, serverId: true },
			with: {
				environment: {
					columns: { environmentId: true },
					with: { project: { columns: { organizationId: true } } },
				},
			},
		}),
	]);

	const service = [
		application,
		composeService,
		libsqlService,
		mariadbService,
		mongoService,
		mysqlService,
		postgresService,
		redisService,
	].find(Boolean);

	if (
		!service ||
		service.environment.project.organizationId !== organizationId ||
		!service.serverId
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Service execution target not found",
		});
	}

	return {
		serviceId,
		serverId: service.serverId,
		appName: service.appName,
		organizationId,
	};
};
