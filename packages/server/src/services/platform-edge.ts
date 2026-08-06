import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	managedDataBackups,
	type PlatformEdgeProvider,
	type PlatformEdgeProviderMetadata,
	type PlatformObjectStorage,
	type PlatformObjectStorageMetadata,
	platformEdgeProviders,
	platformEdgePublications,
	platformObjectStorages,
	platformStaticAssetPublications,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import postgres from "postgres";
import {
	parseBuildOutputArtifactMetadata,
	staticRoutePrefixes,
} from "./build-output-manifest";
import {
	assertCloudflareEdgeConfig,
	type CloudflareEdgeClient,
	type CloudflareEdgeConfig,
	type CloudflareStaticDelivery,
	createCloudflareEdgeClient,
} from "./cloudflare-edge";
import { isPlatformManagedHostname } from "./domain-verification";
import type { EdgeRouter } from "./edge-router";
import type { ReleaseApplication } from "./release-types";
import {
	createS3ObjectStorageClient,
	createS3StaticAssetPublisher,
} from "./static-object-storage";
import { recordUsageEvent } from "./usage-metering";

const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const normalizeHostname = (value: string, field: string) => {
	const normalized = value.trim().toLowerCase().replace(/\.$/, "");
	if (!HOSTNAME_PATTERN.test(normalized)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${field} is invalid`,
		});
	}
	return normalized;
};

const normalizePrefix = (value: string) => {
	const normalized = value.trim().replace(/^\/+|\/+$/g, "");
	if (
		!normalized ||
		normalized.length > 512 ||
		normalized
			.split("/")
			.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Object-storage prefix is invalid",
		});
	}
	return normalized;
};

export const cloudflareConfigFor = (
	provider: PlatformEdgeProvider,
): CloudflareEdgeConfig => ({
	accountId: provider.accountId,
	zoneId: provider.zoneId,
	zoneName: provider.zoneName,
	managedDomain: provider.managedDomain,
	apiToken: provider.apiToken,
	originHostname: provider.originHostname,
	originTokenHash: provider.originTokenHash || "",
	customHostnamesEnabled: provider.metadata.customHostnamesEnabled === true,
	managedWafEnabled: provider.metadata.managedWafEnabled === true,
	cacheEnabled: provider.metadata.cacheEnabled === true,
	geoRoutingEnabled: provider.metadata.geoRoutingEnabled === true,
	originLockdownEnabled: provider.metadata.originLockdownEnabled === true,
	authenticatedOriginPullsEnabled:
		provider.metadata.authenticatedOriginPullsEnabled === true,
	analyticsEnabled: provider.metadata.analyticsEnabled === true,
	cacheTtlSeconds: provider.metadata.cacheTtlSeconds ?? 3600,
	browserTtlSeconds: provider.metadata.browserTtlSeconds ?? 300,
	loadBalancerPoolIds: provider.metadata.loadBalancerPoolIds ?? [],
	loadBalancerFallbackPoolId: provider.metadata.loadBalancerFallbackPoolId,
	loadBalancerRegionPools: provider.metadata.loadBalancerRegionPools,
});

const assertEdgeReadiness = (provider: PlatformEdgeProvider) => {
	if (provider.status !== "active") return;
	assertCloudflareEdgeConfig(cloudflareConfigFor(provider));
	const configuredManagedDomain = process.env.PLATFORM_APPS_DOMAIN?.trim()
		.toLowerCase()
		.replace(/^\*\./, "")
		.replace(/^\.+|\.+$/g, "");
	if (
		configuredManagedDomain &&
		configuredManagedDomain !== provider.managedDomain
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Cloudflare managedDomain must match PLATFORM_APPS_DOMAIN before activation",
		});
	}
	const missing = [
		!provider.metadata.customHostnamesEnabled ? "customHostnamesEnabled" : null,
		!provider.metadata.managedWafEnabled ? "managedWafEnabled" : null,
		!provider.metadata.cacheEnabled ? "cacheEnabled" : null,
		!provider.metadata.originLockdownEnabled ? "originLockdownEnabled" : null,
		!provider.metadata.authenticatedOriginPullsEnabled
			? "authenticatedOriginPullsEnabled"
			: null,
		!provider.metadata.analyticsEnabled ? "analyticsEnabled" : null,
	].filter((value): value is string => Boolean(value));
	if (missing.length > 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Cloudflare edge cannot become active; missing ${missing.join(", ")}`,
		});
	}
};

const assertStorageReadiness = (storage: PlatformObjectStorage) => {
	if (storage.status !== "active") return;
	try {
		createS3ObjectStorageClient({ storage });
	} catch (error) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				error instanceof Error ? error.message : "Object storage is invalid",
		});
	}
};

const activateEdge = async (provider: PlatformEdgeProvider) => {
	assertEdgeReadiness(provider);
	if (provider.status !== "active") return;
	const client = createCloudflareEdgeClient({
		config: cloudflareConfigFor(provider),
	});
	await client.verify();
	await client.configureZoneSecurity();
};

const activateStorage = async (storage: PlatformObjectStorage) => {
	assertStorageReadiness(storage);
	if (storage.status !== "active") return;
	const objectStorage = createS3ObjectStorageClient({ storage });
	if (storage.metadata.managedDataBackups) {
		await objectStorage.verifyManagedDataBackups();
		return;
	}
	const provider = await db.query.platformEdgeProviders.findFirst({
		where: and(
			eq(platformEdgeProviders.status, "active"),
			eq(platformEdgeProviders.isDefault, true),
		),
	});
	if (!provider) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Active object storage requires an active default edge provider",
		});
	}
	await Promise.all([
		objectStorage.verify(),
		createCloudflareEdgeClient({
			config: cloudflareConfigFor(provider),
		}).verifyCdnHostname(new URL(storage.publicBaseUrl).hostname),
	]);
};

export const redactPlatformEdgeProvider = <T extends PlatformEdgeProvider>(
	provider: T,
) => ({
	...provider,
	apiToken: provider.apiToken ? "[REDACTED]" : "",
	originToken: provider.originToken ? "[REDACTED]" : "",
});

export const redactPlatformObjectStorage = <T extends PlatformObjectStorage>(
	storage: T,
) => ({
	...storage,
	accessKeyId: storage.accessKeyId ? "[REDACTED]" : "",
	secretAccessKey: storage.secretAccessKey ? "[REDACTED]" : "",
});

export const createPlatformEdgeProvider = async (
	input: Pick<
		PlatformEdgeProvider,
		| "name"
		| "accountId"
		| "zoneId"
		| "zoneName"
		| "apiToken"
		| "originHostname"
		| "originToken"
		| "managedDomain"
	> &
		Partial<Pick<PlatformEdgeProvider, "status" | "isDefault" | "metadata">>,
) => {
	const candidate = {
		...input,
		provider: "cloudflare" as const,
		status: input.status ?? "provisioning",
		isDefault: input.isDefault ?? false,
		zoneName: normalizeHostname(input.zoneName, "Cloudflare zone name"),
		originHostname: normalizeHostname(
			input.originHostname,
			"Cloudflare origin hostname",
		),
		originTokenHash: `sha256:${createHash("sha256")
			.update(input.originToken)
			.digest("hex")}`,
		managedDomain: normalizeHostname(input.managedDomain, "Managed domain"),
		metadata: input.metadata ?? {},
	};
	assertEdgeReadiness(candidate as PlatformEdgeProvider);
	await activateEdge(candidate as PlatformEdgeProvider);
	const provider = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(781162081)`);
		if (candidate.isDefault) {
			await tx.update(platformEdgeProviders).set({ isDefault: false });
		}
		const [created] = await tx
			.insert(platformEdgeProviders)
			.values(candidate)
			.returning();
		return created;
	});
	if (!provider) throw new Error("Failed to create platform edge provider");
	return redactPlatformEdgeProvider(provider);
};

export const updatePlatformEdgeProvider = async (
	edgeProviderId: string,
	input: Partial<
		Pick<
			PlatformEdgeProvider,
			| "name"
			| "status"
			| "accountId"
			| "zoneId"
			| "zoneName"
			| "apiToken"
			| "originHostname"
			| "originToken"
			| "managedDomain"
			| "isDefault"
			| "metadata"
		>
	>,
) => {
	const current = await db.query.platformEdgeProviders.findFirst({
		where: eq(platformEdgeProviders.edgeProviderId, edgeProviderId),
	});
	if (!current) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Edge provider not found",
		});
	}
	const candidate: PlatformEdgeProvider = {
		...current,
		...input,
		zoneName: input.zoneName
			? normalizeHostname(input.zoneName, "Cloudflare zone name")
			: current.zoneName,
		originHostname: input.originHostname
			? normalizeHostname(input.originHostname, "Cloudflare origin hostname")
			: current.originHostname,
		originTokenHash: input.originToken
			? `sha256:${createHash("sha256").update(input.originToken).digest("hex")}`
			: current.originTokenHash,
		managedDomain: input.managedDomain
			? normalizeHostname(input.managedDomain, "Managed domain")
			: current.managedDomain,
		metadata: input.metadata
			? { ...current.metadata, ...input.metadata }
			: current.metadata,
		updatedAt: new Date(),
	};
	assertEdgeReadiness(candidate);
	await activateEdge(candidate);
	const provider = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(781162081)`);
		if (candidate.isDefault) {
			await tx
				.update(platformEdgeProviders)
				.set({ isDefault: false })
				.where(
					sql`${platformEdgeProviders.edgeProviderId} <> ${edgeProviderId}`,
				);
		}
		const [updated] = await tx
			.update(platformEdgeProviders)
			.set({
				...input,
				originTokenHash: candidate.originTokenHash,
				metadata: candidate.metadata,
				updatedAt: new Date(),
			})
			.where(eq(platformEdgeProviders.edgeProviderId, edgeProviderId))
			.returning();
		return updated;
	});
	if (!provider) throw new Error("Failed to update platform edge provider");
	return redactPlatformEdgeProvider(provider);
};

export const createPlatformObjectStorage = async (
	input: Pick<
		PlatformObjectStorage,
		| "name"
		| "provider"
		| "endpoint"
		| "region"
		| "bucket"
		| "accessKeyId"
		| "secretAccessKey"
		| "publicBaseUrl"
	> &
		Partial<
			Pick<
				PlatformObjectStorage,
				"status" | "prefix" | "forcePathStyle" | "isDefault" | "metadata"
			>
		>,
) => {
	const candidate = {
		...input,
		status: input.status ?? "provisioning",
		prefix: normalizePrefix(input.prefix ?? "vlyv-assets"),
		forcePathStyle: input.forcePathStyle ?? false,
		isDefault: input.isDefault ?? false,
		metadata: input.metadata ?? {},
	};
	assertStorageReadiness(candidate as PlatformObjectStorage);
	await activateStorage(candidate as PlatformObjectStorage);
	const storage = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(781162082)`);
		if (candidate.isDefault) {
			await tx.update(platformObjectStorages).set({ isDefault: false });
		}
		const [created] = await tx
			.insert(platformObjectStorages)
			.values(candidate)
			.returning();
		return created;
	});
	if (!storage) throw new Error("Failed to create platform object storage");
	return redactPlatformObjectStorage(storage);
};

export const updatePlatformObjectStorage = async (
	objectStorageId: string,
	input: Partial<
		Pick<
			PlatformObjectStorage,
			| "name"
			| "provider"
			| "status"
			| "endpoint"
			| "region"
			| "bucket"
			| "accessKeyId"
			| "secretAccessKey"
			| "publicBaseUrl"
			| "prefix"
			| "forcePathStyle"
			| "isDefault"
			| "metadata"
		>
	>,
) => {
	const current = await db.query.platformObjectStorages.findFirst({
		where: eq(platformObjectStorages.objectStorageId, objectStorageId),
	});
	if (!current) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Object storage not found",
		});
	}
	if (
		current.metadata.managedDataBackups &&
		(input.endpoint !== undefined ||
			input.region !== undefined ||
			input.bucket !== undefined ||
			input.prefix !== undefined ||
			input.forcePathStyle !== undefined ||
			input.metadata !== undefined)
	) {
		const retainedArchive = await db.query.managedDataBackups.findFirst({
			where: and(
				eq(managedDataBackups.objectStorageId, objectStorageId),
				ne(managedDataBackups.status, "deleted"),
			),
		});
		if (retainedArchive) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Managed data archive storage is immutable while backups are retained",
			});
		}
	}
	const candidate: PlatformObjectStorage = {
		...current,
		...input,
		prefix: input.prefix ? normalizePrefix(input.prefix) : current.prefix,
		metadata: input.metadata
			? { ...current.metadata, ...input.metadata }
			: current.metadata,
		updatedAt: new Date(),
	};
	assertStorageReadiness(candidate);
	await activateStorage(candidate);
	const storage = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(781162082)`);
		if (candidate.isDefault) {
			await tx
				.update(platformObjectStorages)
				.set({ isDefault: false })
				.where(
					sql`${platformObjectStorages.objectStorageId} <> ${objectStorageId}`,
				);
		}
		const [updated] = await tx
			.update(platformObjectStorages)
			.set({
				...input,
				prefix: candidate.prefix,
				metadata: candidate.metadata,
				updatedAt: new Date(),
			})
			.where(eq(platformObjectStorages.objectStorageId, objectStorageId))
			.returning();
		return updated;
	});
	if (!storage) throw new Error("Failed to update platform object storage");
	return redactPlatformObjectStorage(storage);
};

export const listPlatformEdgeInfrastructure = async () => {
	const [edgeProviders, objectStorages] = await Promise.all([
		db.query.platformEdgeProviders.findMany(),
		db.query.platformObjectStorages.findMany(),
	]);
	return {
		edgeProviders: edgeProviders.map(redactPlatformEdgeProvider),
		objectStorages: objectStorages.map(redactPlatformObjectStorage),
	};
};

export const findDefaultPlatformEdgeProvider = async () =>
	(await db.query.platformEdgeProviders.findFirst({
		where: and(
			eq(platformEdgeProviders.status, "active"),
			eq(platformEdgeProviders.isDefault, true),
		),
	})) ?? null;

export const findDefaultPlatformObjectStorage = async () =>
	(await db.query.platformObjectStorages.findFirst({
		where: and(
			eq(platformObjectStorages.status, "active"),
			eq(platformObjectStorages.isDefault, true),
		),
	})) ?? null;

export const createPlatformStaticAssetPublisher = async () => {
	const storage = await findDefaultPlatformObjectStorage();
	if (!storage) {
		throw new Error("No active default platform object storage is configured");
	}
	return createS3StaticAssetPublisher({ storage });
};

export const removeApplicationStaticAssets = async (applicationId: string) => {
	const publications = await db.query.platformStaticAssetPublications.findMany({
		where: (table, { eq }) => eq(table.applicationId, applicationId),
		with: { storage: true },
	});
	for (const publication of publications) {
		if (publication.storage) {
			await createS3ObjectStorageClient({
				storage: publication.storage,
				allowInactive: true,
			}).deletePrefix(publication.objectPrefix);
		}
		await db
			.delete(platformStaticAssetPublications)
			.where(
				eq(
					platformStaticAssetPublications.staticAssetPublicationId,
					publication.staticAssetPublicationId,
				),
			);
	}
	return publications.length;
};

const domainsFor = (application: ReleaseApplication) =>
	application.releaseDomains ?? application.domains ?? [];

type EdgeRoutingSnapshot = {
	deploymentId: string | null;
	releaseIdentity: string;
	kind: "dns" | "custom_hostname" | "load_balancer";
	status: "pending" | "active" | "failed" | "deleting";
	providerResourceId: string | null;
	errorMessage: string | null;
	metadata: Record<string, unknown>;
};

const staticDeliveryFromMetadata = (
	metadata: Record<string, unknown>,
): CloudflareStaticDelivery | undefined => {
	const value = metadata.staticDelivery;
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<CloudflareStaticDelivery>;
	if (
		typeof candidate.publicBaseUrl !== "string" ||
		!Array.isArray(candidate.routePrefixes) ||
		!candidate.routePrefixes.every((entry) => typeof entry === "string") ||
		!(["container", "static", "hybrid"] as const).includes(
			candidate.mode as "container" | "static" | "hybrid",
		)
	) {
		return undefined;
	}
	return candidate as CloudflareStaticDelivery;
};

const routingSnapshot = (
	publication: typeof platformEdgePublications.$inferSelect | undefined,
): EdgeRoutingSnapshot | null => {
	if (!publication) return null;
	const { previousRouting: _previousRouting, ...metadata } =
		publication.metadata;
	return {
		deploymentId: publication.deploymentId,
		releaseIdentity: publication.releaseIdentity,
		kind: publication.kind,
		status: publication.status,
		providerResourceId: publication.providerResourceId,
		errorMessage: publication.errorMessage,
		metadata,
	};
};

const previousRoutingFromMetadata = (
	metadata: Record<string, unknown>,
): EdgeRoutingSnapshot | null => {
	const value = metadata.previousRouting;
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<EdgeRoutingSnapshot>;
	if (
		(typeof candidate.deploymentId !== "string" &&
			candidate.deploymentId !== null) ||
		typeof candidate.releaseIdentity !== "string" ||
		!(["dns", "custom_hostname", "load_balancer"] as const).includes(
			candidate.kind as "dns" | "custom_hostname" | "load_balancer",
		) ||
		!(["pending", "active", "failed", "deleting"] as const).includes(
			candidate.status as "pending" | "active" | "failed" | "deleting",
		) ||
		(typeof candidate.providerResourceId !== "string" &&
			candidate.providerResourceId !== null) ||
		(typeof candidate.errorMessage !== "string" &&
			candidate.errorMessage !== null) ||
		!candidate.metadata ||
		typeof candidate.metadata !== "object"
	) {
		return null;
	}
	return candidate as EdgeRoutingSnapshot;
};

export const createCloudflarePlatformEdgeRouter = ({
	originRouter,
	provider,
	client = createCloudflareEdgeClient({
		config: cloudflareConfigFor(provider),
	}),
}: {
	originRouter: EdgeRouter;
	provider: PlatformEdgeProvider;
	client?: CloudflareEdgeClient;
}): EdgeRouter => ({
	provider: "cloudflare",
	publish: async (input) => {
		const origin = await originRouter.publish(input);
		const domains = domainsFor(input.application);
		const output = input.artifact
			? parseBuildOutputArtifactMetadata(input.artifact.metadata)
			: null;
		const routePrefixes = output ? staticRoutePrefixes(output.manifest) : [];
		const staticDelivery =
			output &&
			output.manifest.staticOutput.fileCount > 0 &&
			routePrefixes.length > 0
				? {
						publicBaseUrl: output.publicBaseUrl,
						mode: output.manifest.mode,
						routePrefixes,
					}
				: undefined;
		const releaseIdentity =
			input.application.releaseIdentity || input.application.applicationId;
		const existing = await db.query.platformEdgePublications.findMany({
			where: and(
				eq(platformEdgePublications.edgeProviderId, provider.edgeProviderId),
				eq(
					platformEdgePublications.applicationId,
					input.application.applicationId,
				),
			),
		});
		const existingByHostname = new Map(
			existing.map((publication) => [publication.hostname, publication]),
		);
		const published: string[] = [];
		const touchedResources: Array<{
			hostname: string;
			kind: "dns" | "custom_hostname" | "load_balancer";
			resourceId: string | null;
			created: boolean;
			managed: boolean;
			previous: (typeof existing)[number] | undefined;
		}> = [];
		const restoreRouting = async (
			hostname: string,
			previous: (typeof existing)[number] | undefined,
		) => {
			if (previous) {
				await client.configureHostnameRouting(hostname, {
					staticDelivery: staticDeliveryFromMetadata(previous.metadata),
				});
			} else {
				await client.deleteHostnameRouting(hostname);
			}
		};
		const persistPublication = async ({
			hostname,
			kind,
			providerResourceId,
			previous,
		}: {
			hostname: string;
			kind: "dns" | "custom_hostname" | "load_balancer";
			providerResourceId: string | null;
			previous: (typeof existing)[number] | undefined;
		}) => {
			const previousRouting =
				previous?.deploymentId === input.deploymentId
					? previousRoutingFromMetadata(previous.metadata)
					: routingSnapshot(previous);
			const metadata = {
				originProvider: origin.provider,
				staticDelivery,
				previousRouting,
			};
			await db
				.insert(platformEdgePublications)
				.values({
					edgeProviderId: provider.edgeProviderId,
					applicationId: input.application.applicationId,
					deploymentId: input.deploymentId || null,
					releaseIdentity,
					hostname,
					kind,
					status: "active",
					providerResourceId,
					originHostname: provider.originHostname,
					lastMeteredAt: new Date(),
					metadata,
				})
				.onConflictDoUpdate({
					target: [
						platformEdgePublications.edgeProviderId,
						platformEdgePublications.hostname,
					],
					set: {
						applicationId: input.application.applicationId,
						deploymentId: input.deploymentId || null,
						releaseIdentity,
						kind,
						status: "active",
						providerResourceId,
						originHostname: provider.originHostname,
						errorMessage: null,
						metadata,
						updatedAt: new Date(),
					},
				});
		};
		let currentHostname: string | null = null;
		try {
			for (const domain of domains) {
				const hostname = normalizeHostname(domain.host, "Domain hostname");
				const previous = existingByHostname.get(hostname);
				if (previous && previous.releaseIdentity !== releaseIdentity) {
					throw new Error(
						`Edge hostname ${hostname} belongs to another release identity`,
					);
				}
				currentHostname = hostname;
				if (isPlatformManagedHostname(hostname)) {
					try {
						await client.configureHostnameRouting(hostname, { staticDelivery });
					} catch (error) {
						await restoreRouting(hostname, previous).catch(() => undefined);
						throw error;
					}
					touchedResources.push({
						hostname,
						kind: "dns",
						resourceId: null,
						created: !previous,
						managed: true,
						previous,
					});
					await persistPublication({
						hostname,
						kind: "dns",
						providerResourceId: null,
						previous,
					});
					published.push(hostname);
					continue;
				}
				let result: Awaited<ReturnType<typeof client.publishHostname>>;
				try {
					result = await client.publishHostname(hostname, {
						expectedResourceId: previous?.providerResourceId,
						staticDelivery,
					});
				} catch (error) {
					await restoreRouting(hostname, previous).catch(() => undefined);
					throw error;
				}
				touchedResources.push({
					hostname,
					kind: result.kind,
					resourceId: result.resource.id,
					created: result.created,
					managed: false,
					previous,
				});
				await persistPublication({
					hostname,
					kind: result.kind,
					providerResourceId: result.resource.id,
					previous,
				});
				published.push(hostname);
			}
			const desired = new Set(published);
			for (const stale of existing.filter(
				(publication) =>
					publication.releaseIdentity === releaseIdentity &&
					!desired.has(publication.hostname),
			)) {
				if (isPlatformManagedHostname(stale.hostname)) {
					await client.deleteHostnameRouting(stale.hostname);
				} else if (stale.providerResourceId) {
					await client.deleteHostname({
						hostname: stale.hostname,
						kind: stale.kind,
						resourceId: stale.providerResourceId,
					});
				}
				await db
					.delete(platformEdgePublications)
					.where(
						eq(
							platformEdgePublications.edgePublicationId,
							stale.edgePublicationId,
						),
					);
			}
		} catch (error) {
			await Promise.allSettled(
				touchedResources.map(async (touched) => {
					if (touched.created && !touched.managed && touched.resourceId) {
						await client.deleteHostname({
							hostname: touched.hostname,
							kind: touched.kind,
							resourceId: touched.resourceId,
						});
					} else {
						await restoreRouting(touched.hostname, touched.previous);
					}
					if (
						touched.previous &&
						touched.previous.releaseIdentity === releaseIdentity
					) {
						await db
							.update(platformEdgePublications)
							.set({
								applicationId: touched.previous.applicationId,
								deploymentId: touched.previous.deploymentId,
								releaseIdentity: touched.previous.releaseIdentity,
								hostname: touched.previous.hostname,
								kind: touched.previous.kind,
								status: touched.previous.status,
								providerResourceId: touched.previous.providerResourceId,
								errorMessage: touched.previous.errorMessage,
								metadata: touched.previous.metadata,
								updatedAt: new Date(),
							})
							.where(
								eq(
									platformEdgePublications.edgePublicationId,
									touched.previous.edgePublicationId,
								),
							);
					} else {
						await db
							.delete(platformEdgePublications)
							.where(
								and(
									eq(
										platformEdgePublications.edgeProviderId,
										provider.edgeProviderId,
									),
									eq(platformEdgePublications.hostname, touched.hostname),
								),
							);
					}
				}),
			);
			if (currentHostname && !existingByHostname.has(currentHostname)) {
				await db
					.insert(platformEdgePublications)
					.values({
						edgeProviderId: provider.edgeProviderId,
						applicationId: input.application.applicationId,
						deploymentId: input.deploymentId || null,
						releaseIdentity,
						hostname: currentHostname,
						kind: "dns",
						status: "failed",
						originHostname: provider.originHostname,
						errorMessage:
							error instanceof Error
								? error.message
								: "Cloudflare publication failed",
					})
					.onConflictDoUpdate({
						target: [
							platformEdgePublications.edgeProviderId,
							platformEdgePublications.hostname,
						],
						set: {
							applicationId: input.application.applicationId,
							deploymentId: input.deploymentId || null,
							releaseIdentity,
							status: "failed",
							errorMessage:
								error instanceof Error
									? error.message
									: "Cloudflare publication failed",
							updatedAt: new Date(),
						},
					});
			}
			throw error;
		}
		return {
			provider: "cloudflare",
			domains: published,
			publishedAt: new Date().toISOString(),
		};
	},
	rollback: async ({ application, deploymentId }) => {
		const publications = await db.query.platformEdgePublications.findMany({
			where: and(
				eq(platformEdgePublications.edgeProviderId, provider.edgeProviderId),
				eq(platformEdgePublications.applicationId, application.applicationId),
				eq(platformEdgePublications.deploymentId, deploymentId),
			),
		});
		const results = await Promise.allSettled(
			publications.map(async (publication) => {
				const previous = previousRoutingFromMetadata(publication.metadata);
				if (!previous) {
					if (isPlatformManagedHostname(publication.hostname)) {
						await client.deleteHostnameRouting(publication.hostname);
					} else if (publication.providerResourceId) {
						await client.deleteHostname({
							hostname: publication.hostname,
							kind: publication.kind,
							resourceId: publication.providerResourceId,
						});
					} else {
						await client.deleteHostnameRouting(publication.hostname);
					}
					await db
						.delete(platformEdgePublications)
						.where(
							eq(
								platformEdgePublications.edgePublicationId,
								publication.edgePublicationId,
							),
						);
					return;
				}
				await client.configureHostnameRouting(publication.hostname, {
					staticDelivery: staticDeliveryFromMetadata(previous.metadata),
				});
				await db
					.update(platformEdgePublications)
					.set({
						deploymentId: previous.deploymentId,
						releaseIdentity: previous.releaseIdentity,
						kind: previous.kind,
						status: previous.status,
						providerResourceId: previous.providerResourceId,
						errorMessage: previous.errorMessage,
						metadata: previous.metadata,
						updatedAt: new Date(),
					})
					.where(
						eq(
							platformEdgePublications.edgePublicationId,
							publication.edgePublicationId,
						),
					);
			}),
		);
		const failure = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failure) throw failure.reason;
	},
	withdraw: async ({ application }) => {
		const allHostnames = domainsFor(application).map((domain) =>
			normalizeHostname(domain.host, "Domain hostname"),
		);
		const publications =
			allHostnames.length > 0
				? await db.query.platformEdgePublications.findMany({
						where: and(
							eq(
								platformEdgePublications.edgeProviderId,
								provider.edgeProviderId,
							),
							eq(
								platformEdgePublications.applicationId,
								application.applicationId,
							),
							inArray(platformEdgePublications.hostname, allHostnames),
						),
					})
				: [];
		const recordedHostnames = new Set(
			publications.map((publication) => publication.hostname),
		);
		const results = await Promise.allSettled([
			...allHostnames
				.filter(
					(hostname) =>
						isPlatformManagedHostname(hostname) &&
						!recordedHostnames.has(hostname),
				)
				.map((hostname) => client.deleteHostnameRouting(hostname)),
			...publications.map(async (publication) => {
				if (isPlatformManagedHostname(publication.hostname)) {
					await client.deleteHostnameRouting(publication.hostname);
				} else if (publication.providerResourceId) {
					await client.deleteHostname({
						hostname: publication.hostname,
						kind: publication.kind,
						resourceId: publication.providerResourceId,
					});
				}
				await db
					.delete(platformEdgePublications)
					.where(
						eq(
							platformEdgePublications.edgePublicationId,
							publication.edgePublicationId,
						),
					);
			}),
			originRouter.withdraw({ application }),
		]);
		const failure = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failure) throw failure.reason;
	},
});

export const reconcileCloudflareEdgeUsage = async (
	now = new Date(),
	options: {
		provider?: PlatformEdgeProvider;
		client?: CloudflareEdgeClient;
		maxPublications?: number;
	} = {},
) => {
	const provider =
		options.provider ?? (await findDefaultPlatformEdgeProvider());
	if (!provider || !provider.metadata.analyticsEnabled) return 0;
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended('vlyv:cloudflare-usage', 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		return 0;
	}
	try {
		const client =
			options.client ??
			createCloudflareEdgeClient({ config: cloudflareConfigFor(provider) });
		const cutoff = new Date(now.getTime() - 60_000);
		const publications = await db.query.platformEdgePublications.findMany({
			where: and(
				eq(platformEdgePublications.edgeProviderId, provider.edgeProviderId),
				eq(platformEdgePublications.status, "active"),
				lt(platformEdgePublications.lastMeteredAt, cutoff),
			),
			limit: options.maxPublications ?? 100,
			orderBy: [asc(platformEdgePublications.lastMeteredAt)],
			with: {
				application: { with: { environment: { with: { project: true } } } },
			},
		});
		let reconciled = 0;
		for (const publication of publications) {
			const from = publication.lastMeteredAt;
			const to = new Date(
				Math.min(now.getTime(), from.getTime() + 60 * 60 * 1_000),
			);
			try {
				const usage = await client.getUsage({
					hostname: publication.hostname,
					from,
					to,
				});
				const application = publication.application;
				if (!application) continue;
				const period = `${from.toISOString()}:${to.toISOString()}`;
				await Promise.all([
					recordUsageEvent({
						idempotencyKey: `${publication.edgePublicationId}:${period}:requests`,
						organizationId: application.environment.project.organizationId,
						projectId: application.environment.project.projectId,
						environmentId: application.environmentId,
						applicationId: application.applicationId,
						deploymentId: publication.deploymentId,
						metric: "request_count",
						source: "edge",
						quantity: usage.requests,
						unit: "requests",
						periodStart: from,
						periodEnd: to,
						metadata: {
							hostname: publication.hostname,
							provider: "cloudflare",
						},
					}),
					recordUsageEvent({
						idempotencyKey: `${publication.edgePublicationId}:${period}:egress`,
						organizationId: application.environment.project.organizationId,
						projectId: application.environment.project.projectId,
						environmentId: application.environmentId,
						applicationId: application.applicationId,
						deploymentId: publication.deploymentId,
						metric: "egress_bytes",
						source: "edge",
						quantity: usage.egressBytes,
						unit: "bytes",
						periodStart: from,
						periodEnd: to,
						metadata: {
							hostname: publication.hostname,
							provider: "cloudflare",
						},
					}),
				]);
				await db
					.update(platformEdgePublications)
					.set({ lastMeteredAt: to, updatedAt: new Date() })
					.where(
						eq(
							platformEdgePublications.edgePublicationId,
							publication.edgePublicationId,
						),
					);
				reconciled += 1;
			} catch (error) {
				console.error(
					`Failed to reconcile Cloudflare usage for ${publication.hostname}`,
					error,
				);
			}
		}
		return reconciled;
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended('vlyv:cloudflare-usage', 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};

export const withdrawPlatformEdgePublications = async (
	applicationId: string,
) => {
	const publications = await db.query.platformEdgePublications.findMany({
		where: eq(platformEdgePublications.applicationId, applicationId),
		with: { provider: true },
	});
	for (const publication of publications) {
		if (publication.provider) {
			const client = createCloudflareEdgeClient({
				config: cloudflareConfigFor(publication.provider),
			});
			if (isPlatformManagedHostname(publication.hostname)) {
				await client.deleteHostnameRouting(publication.hostname);
			} else if (publication.providerResourceId) {
				await client.deleteHostname({
					hostname: publication.hostname,
					kind: publication.kind,
					resourceId: publication.providerResourceId,
				});
			} else {
				await client.deleteHostnameRouting(publication.hostname);
			}
		}
		await db
			.delete(platformEdgePublications)
			.where(
				eq(
					platformEdgePublications.edgePublicationId,
					publication.edgePublicationId,
				),
			);
	}
	return publications.length;
};

export type EdgeProviderInputMetadata = PlatformEdgeProviderMetadata;
export type ObjectStorageInputMetadata = PlatformObjectStorageMetadata;
