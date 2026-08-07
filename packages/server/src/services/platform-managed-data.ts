import { db } from "@dokploy/server/db";
import {
	type ManagedDataKind,
	type ManagedDataProviderCapabilities,
	type ManagedDataProviderMetadata,
	managedDataResources,
	type PlatformManagedDataProvider,
	platformManagedDataProviders,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { IS_MANAGED_PAAS } from "../constants";
import {
	clearManagedDataProviders,
	createHttpManagedDataProvider,
	getManagedDataProvider,
	listActiveManagedDataProviderNames,
	type ManagedDataProviderPolicy,
	registerManagedDataProvider,
	removeManagedDataProviderDefaults,
} from "./managed-data-provider";
import { createNeonManagedDataProvider } from "./managed-data-providers/neon";

const cleanEndpoint = (
	value: string,
	metadata: ManagedDataProviderMetadata,
) => {
	const url = new URL(value);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" && !metadata.allowInsecure)
	) {
		throw new Error("Managed data provider endpoint must use clean HTTPS");
	}
	return url.toString().replace(/\/$/, "");
};

const capabilitySchema = z.object({
	highAvailability: z.boolean(),
	pooling: z.boolean(),
	pitr: z.boolean(),
	backups: z.boolean(),
	restore: z.boolean(),
	credentialRotation: z.boolean(),
	usage: z.boolean(),
	encryptionAtRest: z.boolean(),
	platformArchive: z.boolean(),
});

const credentialsSchema = {
	neon: z.object({
		apiKey: z.string().min(1),
		organizationId: z.string().min(1).optional(),
	}),
	http: z.object({ token: z.string().min(1) }),
};

const assertPostgresOnlyProvider = (config: {
	type: PlatformManagedDataProvider["type"];
	kinds: ManagedDataKind[];
	defaultKinds: ManagedDataKind[];
}) => {
	if (
		config.type === "upstash" ||
		config.kinds.length !== 1 ||
		config.kinds[0] !== "postgres" ||
		config.defaultKinds.some((kind) => kind !== "postgres")
	) {
		throw new Error("Managed data providers must be PostgreSQL-only");
	}
};

const parseProviderCredentials = (
	type: PlatformManagedDataProvider["type"],
	credentials: unknown,
) => {
	if (type === "neon") return credentialsSchema.neon.parse(credentials);
	if (type === "http") return credentialsSchema.http.parse(credentials);
	throw new Error("Only Neon and PostgreSQL HTTP providers are supported");
};

const providerFor = (config: PlatformManagedDataProvider) => {
	assertPostgresOnlyProvider(config);
	let credentials: unknown;
	try {
		credentials = JSON.parse(config.credentials);
	} catch {
		throw new Error(
			`Managed data provider ${config.name} credentials are invalid`,
		);
	}
	if (config.type === "neon") {
		const parsed = credentialsSchema.neon.parse(credentials);
		return createNeonManagedDataProvider({
			name: config.managedDataProviderId,
			apiKey: parsed.apiKey,
			organizationId: parsed.organizationId,
			apiBase: config.baseUrl,
			validateEndpoint: config.metadata.allowPrivateEndpoint
				? async () => undefined
				: undefined,
		});
	}
	const parsed = credentialsSchema.http.parse(credentials);
	return createHttpManagedDataProvider({
		name: config.managedDataProviderId,
		baseUrl: config.baseUrl,
		token: parsed.token,
		kinds: config.kinds,
		capabilities: config.capabilities,
		validateEndpoint: config.metadata.allowPrivateEndpoint
			? async () => undefined
			: undefined,
	});
};

const policyFor = (
	config: Pick<PlatformManagedDataProvider, "metadata">,
): ManagedDataProviderPolicy => ({
	planMappings: {
		starter: config.metadata.planMappings?.starter || "starter",
		pro: config.metadata.planMappings?.pro || "pro",
		scale: config.metadata.planMappings?.scale || "scale",
	},
	regionMappings: config.metadata.defaultRegions,
});

export const redactPlatformManagedDataProvider = <
	T extends PlatformManagedDataProvider,
>(
	provider: T,
) => ({ ...provider, credentials: "********" });

export const createPlatformManagedDataProvider = async (input: {
	name: string;
	type: "neon" | "http";
	baseUrl: string;
	credentials: Record<string, unknown>;
	kinds: ManagedDataKind[];
	defaultKinds?: ManagedDataKind[];
	capabilities: ManagedDataProviderCapabilities;
	metadata?: ManagedDataProviderMetadata;
}) => {
	if (
		IS_MANAGED_PAAS &&
		process.env.NODE_ENV === "production" &&
		input.type !== "neon"
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed production supports Neon providers only",
		});
	}
	const metadata = input.metadata ?? {};
	const endpoint = cleanEndpoint(input.baseUrl, metadata);
	const capabilities = capabilitySchema.parse(input.capabilities);
	if (!capabilities.encryptionAtRest) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed data providers must attest encryption at rest",
		});
	}
	const kinds = Array.from(new Set(input.kinds));
	const defaultKinds = Array.from(new Set(input.defaultKinds ?? []));
	assertPostgresOnlyProvider({ ...input, kinds, defaultKinds });
	if (
		kinds.length === 0 ||
		defaultKinds.some((kind) => !kinds.includes(kind))
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed data provider kinds are invalid",
		});
	}
	parseProviderCredentials(input.type, input.credentials);
	const [created] = await db
		.insert(platformManagedDataProviders)
		.values({
			...input,
			baseUrl: endpoint,
			credentials: JSON.stringify(input.credentials),
			kinds,
			defaultKinds,
			capabilities,
			metadata,
			status: "provisioning",
		})
		.returning();
	if (!created) throw new Error("Failed to create managed data provider");
	return redactPlatformManagedDataProvider(created);
};

export const updatePlatformManagedDataProvider = async (
	managedDataProviderId: string,
	input: Partial<{
		name: string;
		baseUrl: string;
		credentials: Record<string, unknown>;
		kinds: ManagedDataKind[];
		defaultKinds: ManagedDataKind[];
		capabilities: ManagedDataProviderCapabilities;
		metadata: ManagedDataProviderMetadata;
		status: "provisioning" | "error" | "offline";
	}>,
) => {
	const current = await db.query.platformManagedDataProviders.findFirst({
		where: eq(
			platformManagedDataProviders.managedDataProviderId,
			managedDataProviderId,
		),
	});
	if (!current) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data provider not found",
		});
	}
	const changesPolicy =
		input.name !== undefined ||
		input.baseUrl !== undefined ||
		input.kinds !== undefined ||
		input.defaultKinds !== undefined ||
		input.capabilities !== undefined ||
		input.metadata !== undefined;
	if (
		current.status === "active" &&
		changesPolicy &&
		input.status !== "offline"
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Take an active provider offline before changing its policy",
		});
	}
	if (input.baseUrl !== undefined) {
		const liveResource = await db.query.managedDataResources.findFirst({
			where: and(
				eq(managedDataResources.provider, current.managedDataProviderId),
				ne(managedDataResources.status, "deleted"),
			),
		});
		if (liveResource) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "Provider endpoint is immutable while resources exist",
			});
		}
	}
	const metadata = input.metadata ?? current.metadata;
	const kinds = input.kinds ?? current.kinds;
	const defaultKinds = input.defaultKinds ?? current.defaultKinds;
	assertPostgresOnlyProvider({ ...current, kinds, defaultKinds });
	if (defaultKinds.some((kind) => !kinds.includes(kind))) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Default kinds must be supported by the provider",
		});
	}
	const credentials = input.credentials
		? JSON.stringify(parseProviderCredentials(current.type, input.credentials))
		: current.credentials;
	const capabilities = capabilitySchema.parse(
		input.capabilities ?? current.capabilities,
	);
	if (!capabilities.encryptionAtRest) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed data providers must attest encryption at rest",
		});
	}
	if (input.credentials) {
		const candidate = {
			...current,
			credentials,
			metadata,
			capabilities,
			baseUrl: cleanEndpoint(input.baseUrl ?? current.baseUrl, metadata),
		};
		await providerFor(candidate).verify();
	}
	const [updated] = await db
		.update(platformManagedDataProviders)
		.set({
			...input,
			baseUrl: cleanEndpoint(input.baseUrl ?? current.baseUrl, metadata),
			credentials,
			kinds,
			defaultKinds,
			capabilities,
			metadata,
			updatedAt: new Date(),
		})
		.where(
			eq(
				platformManagedDataProviders.managedDataProviderId,
				managedDataProviderId,
			),
		)
		.returning();
	if (!updated) throw new Error("Failed to update managed data provider");
	if (updated.status === "active") {
		registerManagedDataProvider(
			providerFor(updated),
			updated.defaultKinds,
			policyFor(updated),
		);
	} else {
		removeManagedDataProviderDefaults(updated.managedDataProviderId);
	}
	return redactPlatformManagedDataProvider(updated);
};

export const activatePlatformManagedDataProvider = async (
	managedDataProviderId: string,
) => {
	const config = await db.query.platformManagedDataProviders.findFirst({
		where: eq(
			platformManagedDataProviders.managedDataProviderId,
			managedDataProviderId,
		),
	});
	if (!config) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data provider not found",
		});
	}
	try {
		const provider = providerFor(config);
		await provider.verify();
		const updated = await db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(781162091)`);
			const active = await tx.query.platformManagedDataProviders.findMany({
				where: eq(platformManagedDataProviders.status, "active"),
			});
			for (const kind of config.defaultKinds) {
				if (
					active.some(
						(candidate) =>
							candidate.managedDataProviderId !== managedDataProviderId &&
							candidate.defaultKinds.includes(kind),
					)
				) {
					throw new TRPCError({
						code: "CONFLICT",
						message: `Another active provider already owns the ${kind} service`,
					});
				}
			}
			const [activated] = await tx
				.update(platformManagedDataProviders)
				.set({
					status: "active",
					lastVerifiedAt: new Date(),
					errorMessage: null,
					capabilities: provider.capabilities,
					updatedAt: new Date(),
				})
				.where(
					eq(
						platformManagedDataProviders.managedDataProviderId,
						managedDataProviderId,
					),
				)
				.returning();
			return activated;
		});
		if (!updated) throw new Error("Failed to activate managed data provider");
		registerManagedDataProvider(
			provider,
			updated.defaultKinds,
			policyFor(updated),
		);
		return redactPlatformManagedDataProvider(updated);
	} catch (error) {
		await db
			.update(platformManagedDataProviders)
			.set({
				status: "error",
				errorMessage:
					error instanceof Error
						? error.message.slice(0, 1_000)
						: "Provider verification failed",
				updatedAt: new Date(),
			})
			.where(
				eq(
					platformManagedDataProviders.managedDataProviderId,
					managedDataProviderId,
				),
			);
		throw error;
	}
};

export const loadPlatformManagedDataProviders = async () => {
	const configs = await db.query.platformManagedDataProviders.findMany();
	const verified: Array<{
		config: PlatformManagedDataProvider;
		provider: ReturnType<typeof providerFor>;
	}> = [];
	for (const config of configs) {
		try {
			if (
				IS_MANAGED_PAAS &&
				process.env.NODE_ENV === "production" &&
				config.type !== "neon"
			) {
				throw new Error("Managed production supports Neon providers only");
			}
			const provider = providerFor(config);
			if (config.status === "active") await provider.verify();
			verified.push({ config, provider });
			if (config.status === "active")
				await db
					.update(platformManagedDataProviders)
					.set({
						lastVerifiedAt: new Date(),
						errorMessage: null,
						updatedAt: new Date(),
					})
					.where(
						eq(
							platformManagedDataProviders.managedDataProviderId,
							config.managedDataProviderId,
						),
					);
		} catch (error) {
			await db
				.update(platformManagedDataProviders)
				.set({
					errorMessage:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Provider verification failed",
					updatedAt: new Date(),
				})
				.where(
					eq(
						platformManagedDataProviders.managedDataProviderId,
						config.managedDataProviderId,
					),
				);
			if (config.status === "active") throw error;
			console.error(
				`Ignored unavailable offline managed data provider ${config.managedDataProviderId}`,
			);
		}
	}
	clearManagedDataProviders();
	for (const entry of verified) {
		registerManagedDataProvider(
			entry.provider,
			entry.config.status === "active" ? entry.config.defaultKinds : [],
			policyFor(entry.config),
			entry.config.status === "active",
		);
	}
	return configs.filter((config) => config.status === "active").length;
};

export const verifyRegisteredManagedDataProviders = async () => {
	for (const providerName of listActiveManagedDataProviderNames()) {
		if (!(await getManagedDataProvider(providerName).verify())) {
			throw new Error("Managed data provider health verification failed");
		}
	}
	return true;
};

export const listPlatformManagedDataProviders = async () =>
	(await db.query.platformManagedDataProviders.findMany()).map(
		redactPlatformManagedDataProvider,
	);

export const configureFirstPartyManagedDataProvidersFromEnvironment = () => {
	let configured = 0;
	if (process.env.NEON_API_KEY?.trim()) {
		const provider = createNeonManagedDataProvider({
			name: process.env.NEON_PROVIDER_NAME || "neon",
			apiKey: process.env.NEON_API_KEY,
			organizationId: process.env.NEON_ORGANIZATION_ID?.trim() || undefined,
			apiBase:
				process.env.NEON_API_URL?.trim() || "https://console.neon.tech/api/v2",
		});
		registerManagedDataProvider(provider, ["postgres"], {
			planMappings: { starter: "launch", pro: "launch", scale: "scale" },
			regionMappings: process.env.NEON_REGION_MAPPINGS
				? z
						.record(z.string(), z.string().min(1))
						.parse(JSON.parse(process.env.NEON_REGION_MAPPINGS))
				: undefined,
		});
		configured += 1;
	}
	return configured;
};
