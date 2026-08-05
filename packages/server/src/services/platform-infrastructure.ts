import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type PlatformBuildPool,
	type PlatformCluster,
	type PlatformClusterMetadata,
	type PlatformNodePool,
	type PlatformPlacement,
	type PlatformRegion,
	type PlatformRuntimeTarget,
	platformBuildPools,
	platformClusters,
	platformNodePools,
	platformPlacements,
	platformRegions,
	platformRuntimeTargets,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, count, eq } from "drizzle-orm";

export type KubernetesPlacementCandidate = {
	runtimeTargetId: string;
	runtimeTargetName: string;
	buildPoolId: string;
	buildPoolName: string;
	clusterId: string;
	clusterSlug: string;
	regionId: string;
	regionSlug: string;
	nodePoolId: string | null;
	nodePoolName: string | null;
	placementCount: number;
	maxPlacements: number;
	buildPlacementCount: number;
	maxConcurrentBuilds: number;
	weight: number;
};

export const selectKubernetesPlacementCandidate = (
	candidates: readonly KubernetesPlacementCandidate[],
	preferredRegion?: string | null,
) =>
	candidates
		.filter(
			(candidate) =>
				(candidate.placementCount < candidate.maxPlacements &&
					!preferredRegion) ||
				candidate.regionId === preferredRegion ||
				candidate.regionSlug === preferredRegion,
		)
		.sort((left, right) => {
			const leftScore =
				left.placementCount / Math.max(left.maxPlacements, 1) +
				left.buildPlacementCount / Math.max(left.maxConcurrentBuilds, 1);
			const rightScore =
				right.placementCount / Math.max(right.maxPlacements, 1) +
				right.buildPlacementCount / Math.max(right.maxConcurrentBuilds, 1);
			return (
				leftScore - rightScore ||
				right.weight - left.weight ||
				left.regionSlug.localeCompare(right.regionSlug) ||
				left.clusterSlug.localeCompare(right.clusterSlug) ||
				left.runtimeTargetName.localeCompare(right.runtimeTargetName) ||
				left.buildPoolName.localeCompare(right.buildPoolName)
			);
		})[0];

export const buildApplicationNamespace = (
	organizationId: string,
	applicationId: string,
) => {
	const digest = createHash("sha256")
		.update(`${organizationId}:${applicationId}`)
		.digest("hex")
		.slice(0, 20);
	return `vlyv-app-${digest}`;
};

const getKubernetesPlacementCandidates = async () => {
	const runtimeTargets = await db.query.platformRuntimeTargets.findMany({
		where: and(
			eq(platformRuntimeTargets.runtime, "kubernetes"),
			eq(platformRuntimeTargets.status, "active"),
		),
		with: {
			cluster: {
				with: {
					region: true,
					buildPools: {
						with: {
							nodePool: true,
							placements: { columns: { placementId: true } },
						},
					},
				},
			},
			nodePool: true,
			placements: { columns: { placementId: true } },
		},
	});

	return runtimeTargets.flatMap<KubernetesPlacementCandidate>((target) => {
		if (
			target.cluster.status !== "active" ||
			target.cluster.region.status !== "active" ||
			(target.nodePool &&
				(target.nodePool.status !== "active" ||
					target.nodePool.purpose !== "runtime"))
		) {
			return [];
		}
		const buildPools = target.cluster.buildPools.filter((pool) => {
			try {
				assertBuildPoolReadiness(pool);
				return pool.runtime === "kubernetes" && pool.status === "active";
			} catch {
				return false;
			}
		});
		return buildPools.map((buildPool) => ({
			runtimeTargetId: target.runtimeTargetId,
			runtimeTargetName: target.name,
			buildPoolId: buildPool.buildPoolId,
			buildPoolName: buildPool.name,
			clusterId: target.clusterId,
			clusterSlug: target.cluster.slug,
			regionId: target.cluster.regionId,
			regionSlug: target.cluster.region.slug,
			nodePoolId: target.nodePoolId,
			nodePoolName: target.nodePool?.name ?? null,
			placementCount: target.placements.length,
			maxPlacements: target.maxPlacements,
			buildPlacementCount: buildPool.placements.length,
			maxConcurrentBuilds: buildPool.maxConcurrentBuilds,
			weight: target.weight,
		}));
	});
};

export const hasActiveKubernetesCapacity = async () =>
	Boolean(
		selectKubernetesPlacementCandidate(
			await getKubernetesPlacementCandidates(),
		),
	);

export const ensureApplicationPlatformPlacement = async ({
	applicationId,
	organizationId,
	desiredReplicas = 1,
	preferredRegion,
}: {
	applicationId: string;
	organizationId: string;
	desiredReplicas?: number;
	preferredRegion?: string | null;
}) => {
	const existing = await db.query.platformPlacements.findFirst({
		where: eq(platformPlacements.applicationId, applicationId),
	});
	if (existing) return existing;

	let candidates = await getKubernetesPlacementCandidates();
	while (candidates.length > 0) {
		const candidate = selectKubernetesPlacementCandidate(
			candidates,
			preferredRegion,
		);
		if (!candidate) return null;
		const placement = await db.transaction(async (tx) => {
			const [target] = await tx
				.select({ maxPlacements: platformRuntimeTargets.maxPlacements })
				.from(platformRuntimeTargets)
				.where(
					eq(platformRuntimeTargets.runtimeTargetId, candidate.runtimeTargetId),
				)
				.for("update");
			if (!target) return null;
			const [usage] = await tx
				.select({ total: count() })
				.from(platformPlacements)
				.where(
					eq(platformPlacements.runtimeTargetId, candidate.runtimeTargetId),
				);
			if ((usage?.total ?? 0) >= target.maxPlacements) return null;
			const [created] = await tx
				.insert(platformPlacements)
				.values({
					applicationId,
					organizationId,
					runtimeTargetId: candidate.runtimeTargetId,
					buildPoolId: candidate.buildPoolId,
					namespace: buildApplicationNamespace(organizationId, applicationId),
					desiredReplicas: Math.max(desiredReplicas, 1),
				})
				.onConflictDoNothing({ target: platformPlacements.applicationId })
				.returning();
			return (
				created ??
				(await tx.query.platformPlacements.findFirst({
					where: eq(platformPlacements.applicationId, applicationId),
				})) ??
				null
			);
		});
		if (placement) return placement;
		candidates = candidates.filter(
			(entry) => entry.runtimeTargetId !== candidate.runtimeTargetId,
		);
	}
	return null;
};

export const findApplicationPlatformPlacement = async (applicationId: string) =>
	(await db.query.platformPlacements.findFirst({
		where: eq(platformPlacements.applicationId, applicationId),
		with: {
			runtimeTarget: {
				with: { cluster: { with: { region: true } }, nodePool: true },
			},
			buildPool: { with: { nodePool: true } },
		},
	})) ?? null;

export const markPlatformPlacementReconciled = async (
	placementId: string,
	status: PlatformPlacement["status"],
	metadata?: Record<string, unknown>,
) => {
	const now = new Date();
	await db
		.update(platformPlacements)
		.set({
			status,
			lastReconciledAt: now,
			updatedAt: now,
			...(metadata ? { metadata } : {}),
		})
		.where(eq(platformPlacements.placementId, placementId));
};

export const updatePlatformPlacementReplicas = async (
	applicationId: string,
	desiredReplicas: number,
) => {
	await db
		.update(platformPlacements)
		.set({
			desiredReplicas: Math.max(desiredReplicas, 1),
			updatedAt: new Date(),
		})
		.where(eq(platformPlacements.applicationId, applicationId));
};

export const createPlatformRegion = async (
	input: Pick<PlatformRegion, "slug" | "name" | "provider" | "location"> &
		Partial<Pick<PlatformRegion, "status" | "isDefault" | "metadata">>,
) => {
	const [region] = await db.insert(platformRegions).values(input).returning();
	if (!region) throw new Error("Failed to create platform region");
	return region;
};

export const createPlatformCluster = async (
	input: Pick<PlatformCluster, "regionId" | "slug" | "name" | "runtime"> &
		Partial<
			Pick<
				PlatformCluster,
				"status" | "apiEndpoint" | "kubeconfig" | "isDefault" | "metadata"
			>
		>,
) => {
	if (input.runtime === "kubernetes" && input.status === "active") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Create Kubernetes clusters in provisioning state, add node pools, runtime targets, and build pools, then activate them",
		});
	}
	if (
		input.runtime === "kubernetes" &&
		!input.kubeconfig &&
		!input.metadata?.inCluster
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Kubernetes clusters require an encrypted kubeconfig or in-cluster authentication",
		});
	}
	assertKubernetesClusterReadiness({
		runtime: input.runtime,
		status: input.status ?? "provisioning",
		kubeconfig: input.kubeconfig ?? null,
		metadata: input.metadata ?? {},
	});
	const [cluster] = await db.insert(platformClusters).values(input).returning();
	if (!cluster) throw new Error("Failed to create platform cluster");
	return redactPlatformCluster(cluster);
};

export const createPlatformNodePool = async (
	input: Pick<PlatformNodePool, "clusterId" | "name" | "purpose"> &
		Partial<
			Pick<
				PlatformNodePool,
				| "status"
				| "architecture"
				| "runtimeClassName"
				| "minNodes"
				| "maxNodes"
				| "labels"
				| "taints"
				| "metadata"
			>
		>,
) => {
	if (
		input.minNodes !== undefined &&
		input.maxNodes !== undefined &&
		input.minNodes > input.maxNodes
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "minNodes cannot exceed maxNodes",
		});
	}
	const [nodePool] = await db
		.insert(platformNodePools)
		.values(input)
		.returning();
	if (!nodePool) throw new Error("Failed to create platform node pool");
	return nodePool;
};

const findTargetClusterAndNodePool = async (
	clusterId: string,
	nodePoolId: string | null | undefined,
	expectedPurpose: PlatformNodePool["purpose"],
) => {
	const cluster = await db.query.platformClusters.findFirst({
		where: eq(platformClusters.clusterId, clusterId),
	});
	if (!cluster) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Cluster not found" });
	}
	if (!nodePoolId) return { cluster, nodePool: null };
	const nodePool = await db.query.platformNodePools.findFirst({
		where: and(
			eq(platformNodePools.nodePoolId, nodePoolId),
			eq(platformNodePools.clusterId, clusterId),
		),
	});
	if (!nodePool || nodePool.purpose !== expectedPurpose) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `The selected node pool must be a ${expectedPurpose} pool in the same cluster`,
		});
	}
	return { cluster, nodePool };
};

const assertRuntimeTargetReadiness = ({
	runtime,
	status,
	nodePool,
	clusterMetadata,
}: {
	runtime: PlatformRuntimeTarget["runtime"];
	status: PlatformRuntimeTarget["status"];
	nodePool: PlatformNodePool | null;
	clusterMetadata: PlatformClusterMetadata;
}) => {
	if (runtime !== "kubernetes" || status !== "active") return;
	if (!nodePool || nodePool.status !== "active") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Active Kubernetes runtime targets require an active runtime node pool",
		});
	}
	if (!nodePool.runtimeClassName && !clusterMetadata.runtimeClassName) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Active Kubernetes runtime targets require a sandbox RuntimeClass",
		});
	}
};

export const assertBuildPoolReadiness = (
	pool: Pick<
		PlatformBuildPool,
		| "runtime"
		| "status"
		| "builderImage"
		| "runtimeClassName"
		| "registryHost"
		| "registryRepositoryPrefix"
		| "registryAuthMode"
		| "registryUsername"
		| "registryPassword"
		| "runtimeRegistrySecretName"
		| "metadata"
	> & { nodePool?: PlatformNodePool | null },
) => {
	if (pool.runtime !== "kubernetes" || pool.status !== "active") return;
	const immutableImagePattern = /@sha256:[a-f0-9]{64}$/;
	const registryHostPattern =
		/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d{1,5})?$/;
	const repositoryPrefixPattern =
		/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
	const missing = [
		!pool.builderImage || !immutableImagePattern.test(pool.builderImage)
			? "immutable builderImage"
			: null,
		!pool.runtimeClassName && !pool.nodePool?.runtimeClassName
			? "sandbox runtimeClassName"
			: null,
		!pool.registryHost || !registryHostPattern.test(pool.registryHost)
			? "valid registryHost"
			: null,
		!pool.registryRepositoryPrefix ||
		!repositoryPrefixPattern.test(pool.registryRepositoryPrefix)
			? "valid registryRepositoryPrefix"
			: null,
		pool.registryAuthMode === "basic" && !pool.registryUsername
			? "registryUsername"
			: null,
		pool.registryAuthMode === "basic" && !pool.registryPassword
			? "registryPassword"
			: null,
		pool.registryAuthMode === "basic" && !pool.runtimeRegistrySecretName
			? "runtimeRegistrySecretName"
			: null,
		pool.registryAuthMode === "workload_identity" &&
		!pool.metadata.registryCredentialHelperConfigured
			? "registryCredentialHelperConfigured attestation"
			: null,
		pool.registryAuthMode === "workload_identity" &&
		!pool.metadata.runtimeImagePullIdentityConfigured
			? "runtimeImagePullIdentityConfigured attestation"
			: null,
	].filter((value): value is string => Boolean(value));
	if (missing.length > 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Kubernetes build pool cannot become active; missing ${missing.join(", ")}`,
		});
	}
};

export const createPlatformRuntimeTarget = async (
	input: Pick<PlatformRuntimeTarget, "clusterId" | "name"> &
		Partial<
			Pick<
				PlatformRuntimeTarget,
				"nodePoolId" | "status" | "maxPlacements" | "weight" | "metadata"
			>
		>,
) => {
	const { cluster, nodePool } = await findTargetClusterAndNodePool(
		input.clusterId,
		input.nodePoolId,
		"runtime",
	);
	assertRuntimeTargetReadiness({
		runtime: cluster.runtime,
		status: input.status ?? "provisioning",
		nodePool,
		clusterMetadata: cluster.metadata,
	});
	const [target] = await db
		.insert(platformRuntimeTargets)
		.values({ ...input, runtime: cluster.runtime })
		.returning();
	if (!target) throw new Error("Failed to create platform runtime target");
	return target;
};

export const createPlatformBuildPool = async (
	input: Pick<PlatformBuildPool, "clusterId" | "name"> &
		Partial<
			Pick<
				PlatformBuildPool,
				| "nodePoolId"
				| "status"
				| "builderImage"
				| "runtimeClassName"
				| "maxConcurrentBuilds"
				| "registryHost"
				| "registryRepositoryPrefix"
				| "registryAuthMode"
				| "registryUsername"
				| "registryPassword"
				| "runtimeRegistrySecretName"
				| "metadata"
			>
		>,
) => {
	const { cluster, nodePool } = await findTargetClusterAndNodePool(
		input.clusterId,
		input.nodePoolId,
		"build",
	);
	assertBuildPoolReadiness({
		...input,
		runtime: cluster.runtime,
		status: input.status ?? "provisioning",
		builderImage: input.builderImage ?? null,
		runtimeClassName: input.runtimeClassName ?? null,
		registryHost: input.registryHost ?? null,
		registryRepositoryPrefix: input.registryRepositoryPrefix ?? null,
		registryAuthMode: input.registryAuthMode ?? "basic",
		registryUsername: input.registryUsername ?? null,
		registryPassword: input.registryPassword ?? null,
		runtimeRegistrySecretName: input.runtimeRegistrySecretName ?? null,
		metadata: input.metadata ?? {},
		nodePool,
	});
	const [pool] = await db
		.insert(platformBuildPools)
		.values({ ...input, runtime: cluster.runtime })
		.returning();
	if (!pool) throw new Error("Failed to create platform build pool");
	return redactPlatformBuildPool(pool);
};

export const updatePlatformRuntimeTarget = async (
	runtimeTargetId: string,
	input: Partial<
		Pick<
			PlatformRuntimeTarget,
			"name" | "nodePoolId" | "status" | "maxPlacements" | "weight" | "metadata"
		>
	>,
) => {
	const current = await db.query.platformRuntimeTargets.findFirst({
		where: eq(platformRuntimeTargets.runtimeTargetId, runtimeTargetId),
		with: { cluster: true, nodePool: true },
	});
	if (!current) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Runtime target not found",
		});
	}
	const { nodePool } = await findTargetClusterAndNodePool(
		current.clusterId,
		input.nodePoolId === undefined ? current.nodePoolId : input.nodePoolId,
		"runtime",
	);
	assertRuntimeTargetReadiness({
		runtime: current.runtime,
		status: input.status ?? current.status,
		nodePool,
		clusterMetadata: current.cluster.metadata,
	});
	const [target] = await db
		.update(platformRuntimeTargets)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(platformRuntimeTargets.runtimeTargetId, runtimeTargetId))
		.returning();
	if (!target) throw new Error("Failed to update platform runtime target");
	return target;
};

export const updatePlatformBuildPool = async (
	buildPoolId: string,
	input: Partial<
		Pick<
			PlatformBuildPool,
			| "name"
			| "nodePoolId"
			| "status"
			| "builderImage"
			| "runtimeClassName"
			| "maxConcurrentBuilds"
			| "registryHost"
			| "registryRepositoryPrefix"
			| "registryAuthMode"
			| "registryUsername"
			| "registryPassword"
			| "runtimeRegistrySecretName"
			| "metadata"
		>
	>,
) => {
	const current = await db.query.platformBuildPools.findFirst({
		where: eq(platformBuildPools.buildPoolId, buildPoolId),
		with: { nodePool: true },
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Build pool not found" });
	}
	const { nodePool } = await findTargetClusterAndNodePool(
		current.clusterId,
		input.nodePoolId === undefined ? current.nodePoolId : input.nodePoolId,
		"build",
	);
	const merged = { ...current, ...input, nodePool };
	assertBuildPoolReadiness(merged);
	const [pool] = await db
		.update(platformBuildPools)
		.set({ ...input, updatedAt: new Date() })
		.where(eq(platformBuildPools.buildPoolId, buildPoolId))
		.returning();
	if (!pool) throw new Error("Failed to update platform build pool");
	return redactPlatformBuildPool(pool);
};

export const updatePlatformCluster = async (
	clusterId: string,
	input: Partial<
		Pick<
			PlatformCluster,
			| "name"
			| "status"
			| "apiEndpoint"
			| "kubeconfig"
			| "isDefault"
			| "metadata"
		>
	>,
) => {
	const current = await db.query.platformClusters.findFirst({
		where: eq(platformClusters.clusterId, clusterId),
	});
	if (!current) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Cluster not found" });
	}
	const mergedMetadata = input.metadata
		? { ...current.metadata, ...input.metadata }
		: current.metadata;
	assertKubernetesClusterReadiness({
		runtime: current.runtime,
		status: input.status ?? current.status,
		kubeconfig:
			input.kubeconfig === undefined ? current.kubeconfig : input.kubeconfig,
		metadata: mergedMetadata,
	});
	if (
		current.runtime === "kubernetes" &&
		(input.status ?? current.status) === "active"
	) {
		const [targets, buildPools] = await Promise.all([
			db.query.platformRuntimeTargets.findMany({
				where: and(
					eq(platformRuntimeTargets.clusterId, clusterId),
					eq(platformRuntimeTargets.status, "active"),
				),
				with: { nodePool: true },
			}),
			db.query.platformBuildPools.findMany({
				where: and(
					eq(platformBuildPools.clusterId, clusterId),
					eq(platformBuildPools.status, "active"),
				),
				with: { nodePool: true },
			}),
		]);
		if (targets.length === 0 || buildPools.length === 0) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Kubernetes clusters require an active runtime target and build pool",
			});
		}
		for (const target of targets) {
			assertRuntimeTargetReadiness({
				runtime: target.runtime,
				status: target.status,
				nodePool: target.nodePool,
				clusterMetadata: mergedMetadata,
			});
		}
		for (const pool of buildPools) assertBuildPoolReadiness(pool);
	}
	const [cluster] = await db
		.update(platformClusters)
		.set({
			...input,
			...(input.metadata ? { metadata: mergedMetadata } : {}),
			updatedAt: new Date(),
		})
		.where(eq(platformClusters.clusterId, clusterId))
		.returning();
	if (!cluster) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Cluster not found" });
	}
	return redactPlatformCluster(cluster);
};

export const assertKubernetesClusterReadiness = (cluster: {
	runtime: PlatformCluster["runtime"];
	status: PlatformCluster["status"];
	kubeconfig: string | null;
	metadata: PlatformClusterMetadata;
}) => {
	if (cluster.runtime !== "kubernetes" || cluster.status !== "active") return;
	const missing = [
		!cluster.kubeconfig && !cluster.metadata.inCluster
			? "kubeconfig or inCluster"
			: null,
		!cluster.metadata.secretsEncryptionEnabled
			? "secretsEncryptionEnabled"
			: null,
		!cluster.metadata.networkPolicyEnabled ? "networkPolicyEnabled" : null,
		!cluster.metadata.metricsServerEnabled ? "metricsServerEnabled" : null,
		!cluster.metadata.gatewayApiEnabled ? "gatewayApiEnabled" : null,
		!cluster.metadata.gatewayNamespace ? "gatewayNamespace" : null,
		!cluster.metadata.gatewayName ? "gatewayName" : null,
		!cluster.metadata.gatewayClassName ? "gatewayClassName" : null,
		!cluster.metadata.certManagerEnabled ? "certManagerEnabled" : null,
		!cluster.metadata.certIssuerName ? "certIssuerName" : null,
	].filter((value): value is string => Boolean(value));
	if (missing.length > 0) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: `Kubernetes cluster cannot become active; missing ${missing.join(", ")}`,
		});
	}
};

export const listPlatformInfrastructure = async () => {
	const regions = await db.query.platformRegions.findMany({
		with: {
			clusters: {
				with: {
					nodePools: true,
					runtimeTargets: { with: { placements: true } },
					buildPools: { with: { placements: true } },
				},
			},
		},
	});
	return regions.map((region) => ({
		...region,
		clusters: region.clusters.map((cluster) => ({
			...redactPlatformCluster(cluster),
			buildPools: cluster.buildPools.map(redactPlatformBuildPool),
		})),
	}));
};

export const redactPlatformCluster = <
	T extends PlatformCluster & { metadata: PlatformClusterMetadata },
>(
	cluster: T,
) => ({ ...cluster, kubeconfig: cluster.kubeconfig ? "[REDACTED]" : null });

export const redactPlatformBuildPool = <T extends PlatformBuildPool>(
	pool: T,
) => ({
	...pool,
	registryUsername: pool.registryUsername ? "[REDACTED]" : null,
	registryPassword: pool.registryPassword ? "[REDACTED]" : null,
});
