import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type ApiCredentialScope,
	environments,
	type ManagedDataKind,
	type ManagedDataProviderCapabilities,
	type ManagedDataResource,
	managedDataBackups,
	managedDataBindings,
	managedDataResources,
	platformRegions,
	projects,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import postgres from "postgres";
import { z } from "zod";
import { IS_MANAGED_PAAS } from "../constants";
import { dbUrl } from "../db/constants";
import { assertPublicHealthEndpoint } from "./runtime-scheduler";

export const managedDataPlans = ["starter", "pro", "scale"] as const;
export type ManagedDataPlan = (typeof managedDataPlans)[number];
export const managedDataProductKinds = ["postgres"] as const;

export const managedDataPlanPolicy: Record<
	ManagedDataPlan,
	{
		storageLimitBytes: bigint;
		retentionDays: number;
		highAvailability: boolean;
		replicas: number;
		backupIntervalHours: number;
		backupRetentionDays: number;
	}
> = {
	starter: {
		storageLimitBytes: 1024n ** 3n,
		retentionDays: 1,
		highAvailability: true,
		replicas: 2,
		backupIntervalHours: 24,
		backupRetentionDays: 7,
	},
	pro: {
		storageLimitBytes: 10n * 1024n ** 3n,
		retentionDays: 7,
		highAvailability: true,
		replicas: 2,
		backupIntervalHours: 12,
		backupRetentionDays: 14,
	},
	scale: {
		storageLimitBytes: 100n * 1024n ** 3n,
		retentionDays: 30,
		highAvailability: true,
		replicas: 3,
		backupIntervalHours: 6,
		backupRetentionDays: 35,
	},
};

export type ManagedDataProvisionRequest = {
	managedDataResourceId: string;
	idempotencyKey: string;
	organizationId: string;
	projectId: string;
	environmentId: string;
	regionId: string;
	providerRegion: string;
	kind: ManagedDataKind;
	name: string;
	plan: ManagedDataPlan;
	providerPlan: string;
	storageLimitBytes: bigint;
	retentionDays: number;
	pitrEnabled: boolean;
	highAvailability: boolean;
	poolingEnabled: boolean;
	replicas: number;
	backupEnabled: boolean;
	backupIntervalHours: number;
	backupRetentionDays: number;
};

export type ManagedDataProvisionInput = Pick<
	ManagedDataProvisionRequest,
	| "idempotencyKey"
	| "organizationId"
	| "projectId"
	| "environmentId"
	| "kind"
	| "name"
	| "plan"
> & { regionId?: string | null };

export type ManagedDataProviderResult = {
	providerResourceId: string;
	status: "provisioning" | "ready";
	connectionUri?: string;
	metadata?: Record<string, unknown>;
};

export type ManagedDataProviderBackup = {
	backupId: string;
	status: "pending" | "ready" | "failed";
	createdAt: Date;
	expiresAt?: Date | null;
	sizeBytes?: bigint | null;
	encryption: "provider_kms" | "platform_kms";
	metadata?: Record<string, unknown>;
};

export interface ManagedDataProvider {
	readonly name: string;
	readonly kinds: ReadonlySet<ManagedDataKind>;
	readonly capabilities: ManagedDataProviderCapabilities;
	verify(): Promise<boolean>;
	provision(
		request: ManagedDataProvisionRequest,
	): Promise<ManagedDataProviderResult>;
	getStatus(providerResourceId: string): Promise<ManagedDataProviderResult>;
	getUsage(providerResourceId: string): Promise<{
		consumedBytes: bigint;
		observedAt: Date;
	}>;
	rotateCredentials(
		providerResourceId: string,
	): Promise<{ connectionUri: string }>;
	createBackup(
		providerResourceId: string,
		input: {
			idempotencyKey: string;
			name: string;
			expiresAt: Date;
		},
	): Promise<ManagedDataProviderBackup>;
	getBackup(
		providerResourceId: string,
		backupId: string,
	): Promise<ManagedDataProviderBackup>;
	restoreBackup(
		providerResourceId: string,
		backupId: string,
	): Promise<{ providerResourceId: string; connectionUri?: string }>;
	deleteBackup(providerResourceId: string, backupId: string): Promise<void>;
	delete(providerResourceId: string): Promise<void>;
}

export type ManagedDataProviderPolicy = {
	planMappings: Record<ManagedDataPlan, string>;
	regionMappings?: Record<string, string>;
};

const providers = new Map<string, ManagedDataProvider>();
const defaultProviders = new Map<ManagedDataKind, string>();
const providerPolicies = new Map<string, ManagedDataProviderPolicy>();
const activeProviders = new Set<string>();

export const registerManagedDataProvider = (
	provider: ManagedDataProvider,
	defaultKinds: Iterable<ManagedDataKind> = [],
	policy: ManagedDataProviderPolicy = {
		planMappings: { starter: "starter", pro: "pro", scale: "scale" },
	},
	active = true,
) => {
	for (const plan of managedDataPlans) {
		if (!policy.planMappings[plan]?.trim()) {
			throw new Error(`${provider.name} has no mapping for the ${plan} plan`);
		}
	}
	providers.set(provider.name, provider);
	providerPolicies.set(provider.name, policy);
	if (active) activeProviders.add(provider.name);
	else activeProviders.delete(provider.name);
	for (const kind of defaultKinds) {
		if (!provider.kinds.has(kind)) {
			throw new Error(`${provider.name} cannot be the default for ${kind}`);
		}
		if (
			!provider.capabilities.usage ||
			!provider.capabilities.backups ||
			!provider.capabilities.encryptionAtRest
		) {
			throw new Error(
				`${provider.name} cannot become a default without usage, backups, and encrypted storage`,
			);
		}
		const current = defaultProviders.get(kind);
		if (current && current !== provider.name) {
			throw new Error(`More than one default managed ${kind} provider exists`);
		}
		defaultProviders.set(kind, provider.name);
	}
};

export const clearManagedDataProviders = () => {
	providers.clear();
	defaultProviders.clear();
	providerPolicies.clear();
	activeProviders.clear();
};

export const removeManagedDataProviderDefaults = (name: string) => {
	for (const [kind, providerName] of defaultProviders) {
		if (providerName === name) defaultProviders.delete(kind);
	}
	activeProviders.delete(name);
};

export const listActiveManagedDataProviderNames = () => [...activeProviders];

export const getManagedDataProvider = (
	name: string,
	options: { allowInactive?: boolean } = {},
) => {
	const provider = providers.get(name);
	if (!provider || (!options.allowInactive && !activeProviders.has(name))) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed data service is temporarily unavailable",
		});
	}
	return provider;
};

export const getDefaultManagedDataProvider = (kind: ManagedDataKind) => {
	const providerName = defaultProviders.get(kind);
	if (!providerName) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Managed ${kind} is temporarily unavailable`,
		});
	}
	return getManagedDataProvider(providerName);
};

export const getManagedDataProviderPolicy = (name: string) => {
	const policy = providerPolicies.get(name);
	if (!policy) throw new Error(`Managed data provider ${name} has no policy`);
	return policy;
};

export const listRegisteredManagedDataProviders = () =>
	Array.from(providers.values()).map((provider) => ({
		name: provider.name,
		kinds: Array.from(provider.kinds),
		capabilities: provider.capabilities,
		defaultKinds: Array.from(defaultProviders.entries())
			.filter(([, name]) => name === provider.name)
			.map(([kind]) => kind),
	}));

export const listManagedDataServiceCatalog = () =>
	Array.from(defaultProviders.keys())
		.filter((kind) => kind === "postgres")
		.sort()
		.map((kind) => {
			const capabilities = getDefaultManagedDataProvider(kind).capabilities;
			return {
				kind,
				plans: [...managedDataPlans],
				features: {
					highAvailability: capabilities.highAvailability,
					pooling: capabilities.pooling,
					pitr: capabilities.pitr,
					backups: capabilities.backups,
					credentialRotation: capabilities.credentialRotation,
				},
			};
		});

const databaseProtocols: Record<ManagedDataKind, string[]> = {
	postgres: ["postgres:", "postgresql:"],
	mysql: ["mysql:"],
	mariadb: ["mysql:", "mariadb:"],
	mongo: ["mongodb:", "mongodb+srv:"],
	redis: ["redis:", "rediss:"],
	libsql: ["libsql:", "https:"],
};

export const assertManagedDataConnectionUri = (
	kind: ManagedDataKind,
	value: string,
) => {
	const uri = new URL(value);
	if (!databaseProtocols[kind].includes(uri.protocol)) {
		throw new Error("Managed data provider returned an invalid connection URI");
	}
	if (!uri.hostname || (!uri.password && kind !== "libsql")) {
		throw new Error("Managed data provider returned incomplete credentials");
	}
	const encrypted = (() => {
		switch (kind) {
			case "postgres":
				return ["require", "verify-ca", "verify-full"].includes(
					uri.searchParams.get("sslmode")?.toLowerCase() ?? "",
				);
			case "mysql":
			case "mariadb":
				return (
					["required", "verify_ca", "verify_identity"].includes(
						uri.searchParams.get("ssl-mode")?.toLowerCase() ?? "",
					) || uri.searchParams.get("ssl")?.toLowerCase() === "true"
				);
			case "mongo":
				return (
					uri.protocol === "mongodb+srv:" ||
					uri.searchParams.get("tls")?.toLowerCase() === "true" ||
					uri.searchParams.get("ssl")?.toLowerCase() === "true"
				);
			case "redis":
				return uri.protocol === "rediss:";
			case "libsql":
				return uri.protocol === "https:" || uri.protocol === "libsql:";
		}
	})();
	if (!encrypted) {
		throw new Error("Managed data provider returned an unencrypted connection");
	}
	return uri.toString();
};

const providerProvisionPayload = (input: ManagedDataProvisionRequest) => ({
	...input,
	storageLimitBytes: input.storageLimitBytes.toString(),
});

const providerResponse = z.object({
	providerResourceId: z.string().min(1),
	status: z.enum(["provisioning", "ready"]),
	connectionUri: z.string().min(1).optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});
const providerUsageResponse = z.object({
	consumedBytes: z.union([z.string().regex(/^\d+$/), z.number().int().min(0)]),
	observedAt: z.string().datetime(),
});
const providerBackupResponse = z.object({
	backupId: z.string().min(1),
	status: z.enum(["pending", "ready", "failed"]),
	createdAt: z.string().datetime(),
	expiresAt: z.string().datetime().nullable().optional(),
	sizeBytes: z
		.union([z.string().regex(/^\d+$/), z.number().int().min(0)])
		.nullable()
		.optional(),
	encryption: z.enum(["provider_kms", "platform_kms"]),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

const backupFromResponse = (value: z.infer<typeof providerBackupResponse>) => ({
	...value,
	createdAt: new Date(value.createdAt),
	expiresAt: value.expiresAt ? new Date(value.expiresAt) : null,
	sizeBytes:
		value.sizeBytes === null || value.sizeBytes === undefined
			? null
			: BigInt(value.sizeBytes),
});

export const createHttpManagedDataProvider = ({
	name,
	baseUrl,
	token,
	kinds,
	capabilities,
	fetcher = fetch,
	validateEndpoint = assertPublicHealthEndpoint,
}: {
	name: string;
	baseUrl: string;
	token: string;
	kinds: ManagedDataKind[];
	capabilities?: Partial<ManagedDataProviderCapabilities>;
	fetcher?: typeof fetch;
	validateEndpoint?: (endpoint: string) => Promise<void>;
}): ManagedDataProvider => {
	const providerUrl = new URL(baseUrl);
	if (providerUrl.protocol !== "https:") {
		throw new Error("Managed data provider URL must use HTTPS");
	}
	const request = async <T>(
		path: string,
		init: RequestInit,
		schema: z.ZodType<T>,
		allowNotFound = false,
	) => {
		await validateEndpoint(providerUrl.toString());
		const response = await fetcher(new URL(path, baseUrl), {
			...init,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${token}`,
				...init.headers,
			},
			signal: AbortSignal.timeout(30_000),
			redirect: "error",
		});
		if (allowNotFound && response.status === 404) return undefined as T;
		if (!response.ok) {
			throw new Error(`Managed data provider returned HTTP ${response.status}`);
		}
		return schema.parse(await response.json());
	};

	return {
		name,
		kinds: new Set(kinds),
		capabilities: {
			highAvailability: false,
			pooling: false,
			pitr: false,
			backups: false,
			restore: false,
			credentialRotation: false,
			usage: false,
			encryptionAtRest: false,
			platformArchive: false,
			...capabilities,
		},
		verify: async () => {
			await request(
				"/v1/health",
				{ method: "GET" },
				z.object({ status: z.literal("ok") }),
			);
			return true;
		},
		provision: async (input) =>
			request(
				"/v1/resources",
				{
					method: "POST",
					body: JSON.stringify(providerProvisionPayload(input)),
				},
				providerResponse,
			).then((result) => ({
				...result,
				connectionUri: result.connectionUri
					? assertManagedDataConnectionUri(input.kind, result.connectionUri)
					: undefined,
			})),
		getStatus: async (providerResourceId) =>
			request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}`,
				{ method: "GET" },
				providerResponse,
			),
		getUsage: async (providerResourceId) => {
			const usage = await request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}/usage`,
				{ method: "GET" },
				providerUsageResponse,
			);
			return {
				consumedBytes: BigInt(usage.consumedBytes),
				observedAt: new Date(usage.observedAt),
			};
		},
		rotateCredentials: async (providerResourceId) =>
			request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}/credentials/rotate`,
				{ method: "POST" },
				z.object({ connectionUri: z.string().min(1) }),
			),
		createBackup: async (providerResourceId, input) =>
			backupFromResponse(
				await request(
					`/v1/resources/${encodeURIComponent(providerResourceId)}/backups`,
					{
						method: "POST",
						body: JSON.stringify({
							...input,
							expiresAt: input.expiresAt.toISOString(),
						}),
					},
					providerBackupResponse,
				),
			),
		getBackup: async (providerResourceId, backupId) =>
			backupFromResponse(
				await request(
					`/v1/resources/${encodeURIComponent(providerResourceId)}/backups/${encodeURIComponent(backupId)}`,
					{ method: "GET" },
					providerBackupResponse,
				),
			),
		restoreBackup: async (providerResourceId, backupId) => {
			await request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}/backups/${encodeURIComponent(backupId)}/restore`,
				{ method: "POST" },
				z.object({ status: z.enum(["accepted", "restoring"]) }),
			);
			const deadline = Date.now() + 10 * 60_000;
			while (Date.now() < deadline) {
				const status = await request(
					`/v1/resources/${encodeURIComponent(providerResourceId)}`,
					{ method: "GET" },
					providerResponse,
				);
				if (status.status === "ready") {
					return {
						providerResourceId: status.providerResourceId,
						connectionUri: status.connectionUri,
					};
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
			}
			throw new Error("Managed data provider restore timed out");
		},
		deleteBackup: async (providerResourceId, backupId) => {
			await request(
				`/v1/resources/${encodeURIComponent(providerResourceId)}/backups/${encodeURIComponent(backupId)}`,
				{ method: "DELETE" },
				z.object({ status: z.enum(["deleted", "accepted"]) }),
				true,
			);
		},
		delete: async (providerResourceId) => {
			await validateEndpoint(providerUrl.toString());
			const response = await fetcher(
				new URL(
					`/v1/resources/${encodeURIComponent(providerResourceId)}`,
					baseUrl,
				),
				{
					method: "DELETE",
					headers: { authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(30_000),
					redirect: "error",
				},
			);
			if (!response.ok && response.status !== 404) {
				throw new Error(
					`Managed data provider returned HTTP ${response.status}`,
				);
			}
		},
	};
};

const validateOwnership = async (input: ManagedDataProvisionInput) => {
	const [project, environment] = await Promise.all([
		db.query.projects.findFirst({
			where: and(
				eq(projects.projectId, input.projectId),
				eq(projects.organizationId, input.organizationId),
			),
		}),
		db.query.environments.findFirst({
			where: and(
				eq(environments.environmentId, input.environmentId),
				eq(environments.projectId, input.projectId),
			),
		}),
	]);
	if (!project || !environment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data project or environment was not found",
		});
	}
};

const provisioningHash = (input: ManagedDataProvisionInput, regionId: string) =>
	`sha256:${createHash("sha256")
		.update(
			JSON.stringify({
				organizationId: input.organizationId,
				projectId: input.projectId,
				environmentId: input.environmentId,
				regionId,
				kind: input.kind,
				name: input.name,
				plan: input.plan,
			}),
		)
		.digest("hex")}`;

const nextReconcileAt = (attempts: number, now = new Date()) =>
	new Date(
		now.getTime() +
			Math.min(15_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 6), 900_000),
	);

export const withManagedDataResourceMutationLock = async <T>(
	managedDataResourceId: string,
	operation: () => Promise<T>,
) => {
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const lockName = `vlyv:managed-data-resource:${managedDataResourceId}`;
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended(${lockName}, 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		throw new TRPCError({
			code: "CONFLICT",
			message: "Another managed data operation is already running",
		});
	}
	try {
		return await operation();
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended(${lockName}, 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};

const managedDataRegion = async (regionId?: string | null) => {
	const region = regionId
		? await db.query.platformRegions.findFirst({
				where: and(
					eq(platformRegions.regionId, regionId),
					eq(platformRegions.status, "active"),
				),
			})
		: await db.query.platformRegions.findFirst({
				where: and(
					eq(platformRegions.status, "active"),
					eq(platformRegions.isDefault, true),
				),
			});
	if (!region) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed data is unavailable in the selected region",
		});
	}
	return region;
};

export const managedDataProvisionRequestForResource = async (
	resource: ManagedDataResource,
): Promise<ManagedDataProvisionRequest> => {
	const plan = managedDataPlans.includes(resource.plan as ManagedDataPlan)
		? (resource.plan as ManagedDataPlan)
		: "starter";
	const policy = getManagedDataProviderPolicy(resource.provider);
	const region = resource.regionId
		? await db.query.platformRegions.findFirst({
				where: eq(platformRegions.regionId, resource.regionId),
			})
		: await db.query.platformRegions.findFirst({
				where: eq(platformRegions.isDefault, true),
			});
	if (!region) throw new Error("Managed data platform region is unavailable");
	const providerRegion =
		typeof resource.metadata.providerRegion === "string"
			? resource.metadata.providerRegion
			: (policy.regionMappings?.[region.slug] ?? region.slug);
	const providerPlan =
		typeof resource.metadata.providerPlan === "string"
			? resource.metadata.providerPlan
			: policy.planMappings[plan];
	return {
		managedDataResourceId: resource.managedDataResourceId,
		idempotencyKey: resource.idempotencyKey,
		organizationId: resource.organizationId,
		projectId: resource.projectId,
		environmentId: resource.environmentId,
		regionId: region.regionId,
		providerRegion,
		kind: resource.kind,
		name: resource.name,
		plan,
		providerPlan,
		storageLimitBytes:
			resource.storageLimitBytes ??
			managedDataPlanPolicy[plan].storageLimitBytes,
		retentionDays: resource.retentionDays,
		pitrEnabled: resource.pitrEnabled,
		highAvailability: resource.highAvailability,
		poolingEnabled: resource.poolingEnabled,
		replicas: resource.replicas,
		backupEnabled: resource.backupEnabled,
		backupIntervalHours: resource.backupIntervalHours,
		backupRetentionDays: resource.backupRetentionDays,
	};
};

const persistProviderResult = async (
	resource: ManagedDataResource,
	result: ManagedDataProviderResult,
) => {
	const connectionUri = result.connectionUri
		? assertManagedDataConnectionUri(resource.kind, result.connectionUri)
		: resource.connectionUri;
	const credentialsChanged =
		Boolean(connectionUri) && connectionUri !== resource.connectionUri;
	if (result.status === "ready" && !connectionUri) {
		throw new Error("Managed data provider returned no runtime credentials");
	}
	const now = new Date();
	const [updated] = await db
		.update(managedDataResources)
		.set({
			providerResourceId: result.providerResourceId,
			status: result.status,
			connectionUri,
			credentialVersion: credentialsChanged
				? sql`${managedDataResources.credentialVersion} + 1`
				: resource.credentialVersion,
			errorMessage: null,
			lifecycleAttempts: 0,
			nextReconcileAt: new Date(now.getTime() + 5 * 60_000),
			lastHealthyAt: result.status === "ready" ? now : resource.lastHealthyAt,
			metadata: {
				...resource.metadata,
				...result.metadata,
				capabilities: getManagedDataProvider(resource.provider).capabilities,
			},
			updatedAt: now,
		})
		.where(
			and(
				eq(
					managedDataResources.managedDataResourceId,
					resource.managedDataResourceId,
				),
				inArray(managedDataResources.status, [
					"provisioning",
					"ready",
					"error",
					"restoring",
				]),
			),
		)
		.returning();
	if (!updated) throw new Error("Managed data lifecycle changed concurrently");
	return updated;
};

export const reconcileManagedDataResource = async (
	inputResource: ManagedDataResource,
): Promise<ManagedDataResource> => {
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const lockName = `vlyv:managed-data-resource:${inputResource.managedDataResourceId}`;
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended(${lockName}, 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		const current = await findManagedDataResource(
			inputResource.managedDataResourceId,
		);
		if (current.status === "ready" || current.status === "deleted") {
			return current;
		}
		throw new TRPCError({
			code: "CONFLICT",
			message: "Managed data operation is already running",
		});
	}
	try {
		const current = await findManagedDataResource(
			inputResource.managedDataResourceId,
		);
		if (current.status === "deleted") return current;
		const resource = current;
		if (resource.status === "deleting") {
			const backups = await db.query.managedDataBackups.findMany({
				where: eq(
					managedDataBackups.managedDataResourceId,
					resource.managedDataResourceId,
				),
			});
			const { deleteManagedDataBackupUnderResourceLock } = await import(
				"./managed-data-backup"
			);
			for (const backup of backups) {
				if (backup.status !== "deleted") {
					await deleteManagedDataBackupUnderResourceLock(
						backup.managedDataBackupId,
					);
				}
			}
			if (resource.providerResourceId) {
				await getManagedDataProvider(resource.provider, {
					allowInactive: true,
				}).delete(resource.providerResourceId);
			}
			const [deleted] = await db
				.update(managedDataResources)
				.set({
					status: "deleted",
					connectionUri: null,
					errorMessage: null,
					nextReconcileAt: new Date("9999-12-31T00:00:00.000Z"),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(
							managedDataResources.managedDataResourceId,
							resource.managedDataResourceId,
						),
						eq(managedDataResources.status, "deleting"),
					),
				)
				.returning();
			if (!deleted)
				throw new Error("Managed data deletion changed concurrently");
			return deleted;
		}

		const provider = getManagedDataProvider(resource.provider);
		try {
			const result = resource.providerResourceId
				? await provider.getStatus(resource.providerResourceId)
				: await provider.provision(
						await managedDataProvisionRequestForResource(resource),
					);
			return persistProviderResult(resource, result);
		} catch (error) {
			const attempts = resource.lifecycleAttempts + 1;
			await db
				.update(managedDataResources)
				.set({
					status:
						resource.status === "ready" && attempts < 10
							? "ready"
							: attempts >= 10
								? "error"
								: "provisioning",
					lifecycleAttempts: attempts,
					nextReconcileAt: nextReconcileAt(attempts),
					errorMessage:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Managed data reconciliation failed",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(
							managedDataResources.managedDataResourceId,
							resource.managedDataResourceId,
						),
						inArray(managedDataResources.status, [
							"provisioning",
							"ready",
							"error",
						]),
					),
				);
			throw error;
		}
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended(${lockName}, 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};

export const provisionManagedDataResource = async (
	input: ManagedDataProvisionInput,
) => {
	if (input.kind !== "postgres") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only managed PostgreSQL is available",
		});
	}
	await validateOwnership(input);
	const provider = getDefaultManagedDataProvider(input.kind);
	if (!provider.kinds.has(input.kind)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed data kind is unavailable",
		});
	}
	if (!provider.capabilities.encryptionAtRest) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed data encrypted storage is unavailable",
		});
	}
	const region = await managedDataRegion(input.regionId);
	const plan = managedDataPlanPolicy[input.plan];
	const providerPolicy = getManagedDataProviderPolicy(provider.name);
	const providerRegion =
		providerPolicy.regionMappings?.[region.slug] ?? region.slug;
	const providerPlan = providerPolicy.planMappings[input.plan];
	const pitrEnabled = true;
	const poolingEnabled = true;
	const backupEnabled = true;
	for (const [required, supported, capability] of [
		[
			plan.highAvailability,
			provider.capabilities.highAvailability,
			"high availability",
		],
		[poolingEnabled, provider.capabilities.pooling, "connection pooling"],
		[pitrEnabled, provider.capabilities.pitr, "point-in-time recovery"],
		[backupEnabled, provider.capabilities.backups, "automated backups"],
	] as const) {
		if (required && !supported) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Managed ${capability} is unavailable for this service`,
			});
		}
	}
	const requestHash = provisioningHash(input, region.regionId);
	const existing = await db.query.managedDataResources.findFirst({
		where: and(
			eq(managedDataResources.organizationId, input.organizationId),
			eq(managedDataResources.idempotencyKey, input.idempotencyKey),
		),
	});
	if (existing) {
		const matchingLegacyRequest =
			existing.requestHash.startsWith("legacy:") &&
			existing.projectId === input.projectId &&
			existing.environmentId === input.environmentId &&
			existing.regionId === region.regionId &&
			existing.kind === input.kind &&
			existing.name === input.name &&
			existing.plan === input.plan;
		if (existing.requestHash !== requestHash && !matchingLegacyRequest) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Idempotency key was already used for another request",
			});
		}
		if (
			["provisioning", "error"].includes(existing.status) &&
			existing.nextReconcileAt <= new Date()
		) {
			return managedDataResourceForTenant(
				await reconcileManagedDataResource(existing),
			);
		}
		return managedDataResourceForTenant(existing);
	}

	const [inserted] = await db
		.insert(managedDataResources)
		.values({
			idempotencyKey: input.idempotencyKey,
			requestHash,
			organizationId: input.organizationId,
			projectId: input.projectId,
			environmentId: input.environmentId,
			regionId: region.regionId,
			provider: provider.name,
			kind: input.kind,
			name: input.name,
			plan: input.plan,
			storageLimitBytes: plan.storageLimitBytes,
			retentionDays: plan.retentionDays,
			pitrEnabled,
			highAvailability: plan.highAvailability,
			poolingEnabled,
			replicas: plan.replicas,
			backupEnabled,
			backupIntervalHours: plan.backupIntervalHours,
			backupRetentionDays: plan.backupRetentionDays,
			nextBackupAt: new Date(
				Date.now() + plan.backupIntervalHours * 60 * 60 * 1_000,
			),
			metadata: { providerRegion, providerPlan },
		})
		.onConflictDoNothing({
			target: [
				managedDataResources.organizationId,
				managedDataResources.idempotencyKey,
			],
		})
		.returning();
	const record =
		inserted ??
		(await db.query.managedDataResources.findFirst({
			where: and(
				eq(managedDataResources.organizationId, input.organizationId),
				eq(managedDataResources.idempotencyKey, input.idempotencyKey),
			),
		}));
	if (!record || record.requestHash !== requestHash) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Idempotency key was already used for another request",
		});
	}
	return managedDataResourceForTenant(
		await reconcileManagedDataResource(record),
	);
};

export const refreshManagedDataResource = async (resourceId: string) => {
	const resource = await findManagedDataResource(resourceId);
	if (resource.status === "deleted")
		return managedDataResourceForTenant(resource);
	return managedDataResourceForTenant(
		await reconcileManagedDataResource({
			...resource,
			lifecycleAttempts: 0,
		}),
	);
};

const rotateManagedDataCredentialsUnlocked = async (resourceId: string) => {
	const resource = await findManagedDataResource(resourceId);
	if (!resource.providerResourceId) {
		throw new Error("Managed data resource is not provisioned");
	}
	const pendingBinding = await db.query.managedDataBindings.findFirst({
		where: and(
			eq(managedDataBindings.managedDataResourceId, resourceId),
			sql`${managedDataBindings.appliedCredentialVersion} < ${resource.credentialVersion}`,
		),
	});
	if (pendingBinding) {
		const { synchronizeManagedDataBindingSecrets } = await import(
			"./managed-data-binding"
		);
		await synchronizeManagedDataBindingSecrets(resourceId);
		return true;
	}
	const provider = getManagedDataProvider(resource.provider);
	if (!provider.capabilities.credentialRotation) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Credential rotation is unavailable for this service",
		});
	}
	const rotated = await provider.rotateCredentials(resource.providerResourceId);
	const connectionUri = assertManagedDataConnectionUri(
		resource.kind,
		rotated.connectionUri,
	);
	const [updated] = await db
		.update(managedDataResources)
		.set({
			connectionUri,
			credentialVersion: sql`${managedDataResources.credentialVersion} + 1`,
			updatedAt: new Date(),
		})
		.where(eq(managedDataResources.managedDataResourceId, resourceId))
		.returning();
	if (!updated) throw new Error("Failed to persist rotated credentials");
	const { synchronizeManagedDataBindingSecrets } = await import(
		"./managed-data-binding"
	);
	await synchronizeManagedDataBindingSecrets(resourceId);
	return true;
};

export const rotateManagedDataCredentials = async (resourceId: string) =>
	withManagedDataResourceMutationLock(resourceId, () =>
		rotateManagedDataCredentialsUnlocked(resourceId),
	);

const requestManagedDataResourceDeletion = async (resourceId: string) => {
	const resource = await findManagedDataResource(resourceId);
	if (resource.status === "deleted") return true;
	const binding = await db.query.managedDataBindings.findFirst({
		where: eq(managedDataBindings.managedDataResourceId, resourceId),
	});
	if (binding) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Remove application bindings before deleting this data service",
		});
	}
	await db
		.update(managedDataResources)
		.set({
			status: "deleting",
			deletionRequestedAt: resource.deletionRequestedAt ?? new Date(),
			nextReconcileAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(managedDataResources.managedDataResourceId, resourceId));
	return true;
};

export const deleteManagedDataResource = async (resourceId: string) => {
	await withManagedDataResourceMutationLock(resourceId, () =>
		requestManagedDataResourceDeletion(resourceId),
	);
	return managedDataResourceForTenant(
		await findManagedDataResource(resourceId),
	);
};

export const reconcileManagedDataResources = async (
	now = new Date(),
	maxResources = 100,
) => {
	if (
		!Number.isSafeInteger(maxResources) ||
		maxResources < 1 ||
		maxResources > 1_000
	) {
		throw new Error("Managed data reconciliation limit is invalid");
	}
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended('vlyv:managed-data-lifecycle', 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		return { reconciled: 0, failed: 0 };
	}
	try {
		const resources = await db.query.managedDataResources.findMany({
			where: and(
				inArray(managedDataResources.status, [
					"provisioning",
					"ready",
					"error",
					"deleting",
				]),
				lte(managedDataResources.nextReconcileAt, now),
			),
			orderBy: [asc(managedDataResources.nextReconcileAt)],
			limit: maxResources,
		});
		let reconciled = 0;
		let failed = 0;
		for (const resource of resources) {
			try {
				await reconcileManagedDataResource(resource);
				reconciled += 1;
			} catch (error) {
				failed += 1;
				console.error(
					`Failed to reconcile managed data resource ${resource.managedDataResourceId}`,
					error,
				);
			}
		}
		return { reconciled, failed };
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended('vlyv:managed-data-lifecycle', 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};

export const findManagedDataResource = async (resourceId: string) => {
	const resource = await db.query.managedDataResources.findFirst({
		where: eq(managedDataResources.managedDataResourceId, resourceId),
	});
	if (!resource) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data resource not found",
		});
	}
	return resource;
};

export const listManagedDataResources = async (organizationId: string) =>
	(
		await db.query.managedDataResources.findMany({
			where: eq(managedDataResources.organizationId, organizationId),
		})
	).map(managedDataResourceForTenant);

export const filterManagedDataResourcesForScope = <
	T extends { projectId: string; environmentId: string },
>(
	resources: T[],
	scope: ApiCredentialScope | null | undefined,
) => {
	if (!scope) return resources;
	return resources.filter(
		(resource) =>
			(scope.projectIds.length === 0 ||
				scope.projectIds.includes(resource.projectId)) &&
			(scope.environmentIds.length === 0 ||
				scope.environmentIds.includes(resource.environmentId)),
	);
};

export const managedDataResourceForTenant = (
	resource: ManagedDataResource,
) => ({
	managedDataResourceId: resource.managedDataResourceId,
	projectId: resource.projectId,
	environmentId: resource.environmentId,
	kind: resource.kind,
	status: resource.status,
	name: resource.name,
	plan: resource.plan,
	storageLimitBytes: resource.storageLimitBytes?.toString() ?? null,
	retentionDays: resource.retentionDays,
	pitrEnabled: resource.pitrEnabled,
	highAvailability: resource.highAvailability,
	poolingEnabled: resource.poolingEnabled,
	backupEnabled: resource.backupEnabled,
	backupIntervalHours: resource.backupIntervalHours,
	backupRetentionDays: resource.backupRetentionDays,
	nextBackupAt: resource.nextBackupAt,
	lastBackupAt: resource.lastBackupAt,
	error: resource.status === "error" ? "Managed data operation failed" : null,
	createdAt: resource.createdAt,
	updatedAt: resource.updatedAt,
});

/** @deprecated Use the strict tenant DTO serializer. */
export const redactManagedDataResource = managedDataResourceForTenant;

export const configureManagedDataProviderFromEnvironment = () => {
	const baseUrl = process.env.MANAGED_DATA_PROVIDER_URL;
	const token = process.env.MANAGED_DATA_PROVIDER_TOKEN;
	if (!baseUrl || !token) return null;
	if (IS_MANAGED_PAAS && process.env.NODE_ENV === "production") {
		throw new Error(
			"Managed production supports Neon only; generic managed data providers are disabled",
		);
	}
	const capabilitiesValue = process.env.MANAGED_DATA_PROVIDER_CAPABILITIES;
	if (!capabilitiesValue) {
		throw new Error(
			"MANAGED_DATA_PROVIDER_CAPABILITIES is required for a generic provider",
		);
	}
	const capabilities = z
		.object({
			highAvailability: z.boolean(),
			pooling: z.boolean(),
			pitr: z.boolean(),
			backups: z.boolean(),
			restore: z.boolean(),
			credentialRotation: z.boolean(),
			usage: z.boolean(),
			encryptionAtRest: z.literal(true),
			platformArchive: z.boolean(),
		})
		.parse(JSON.parse(capabilitiesValue));
	const provider = createHttpManagedDataProvider({
		name: process.env.MANAGED_DATA_PROVIDER_NAME || "default",
		baseUrl,
		token,
		kinds: ["postgres"],
		capabilities,
		validateEndpoint:
			process.env.MANAGED_DATA_PROVIDER_ALLOW_PRIVATE === "true"
				? async () => undefined
				: assertPublicHealthEndpoint,
	});
	const parseMap = (value: string | undefined) => {
		if (!value?.trim()) return {};
		return z.record(z.string(), z.string().min(1)).parse(JSON.parse(value));
	};
	const configuredPlans = parseMap(
		process.env.MANAGED_DATA_PROVIDER_PLAN_MAPPINGS,
	);
	registerManagedDataProvider(provider, ["postgres"], {
		planMappings: {
			starter: configuredPlans.starter || "starter",
			pro: configuredPlans.pro || "pro",
			scale: configuredPlans.scale || "scale",
		},
		regionMappings: parseMap(process.env.MANAGED_DATA_PROVIDER_REGION_MAPPINGS),
	});
	return provider.name;
};
