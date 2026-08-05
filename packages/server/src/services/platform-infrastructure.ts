import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type PlatformCluster,
	type PlatformClusterMetadata,
	type PlatformNodePool,
	type PlatformPlacement,
	type PlatformRegion,
	platformClusters,
	platformNodePools,
	platformPlacements,
	platformRegions,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

export type KubernetesPlacementCandidate = {
	clusterId: string;
	clusterSlug: string;
	regionId: string;
	regionSlug: string;
	nodePoolId: string | null;
	nodePoolName: string | null;
	placementCount: number;
	maxNodes: number;
};

export const selectKubernetesPlacementCandidate = (
	candidates: readonly KubernetesPlacementCandidate[],
	preferredRegion?: string | null,
) =>
	candidates
		.filter(
			(candidate) =>
				!preferredRegion ||
				candidate.regionId === preferredRegion ||
				candidate.regionSlug === preferredRegion,
		)
		.sort((left, right) => {
			const leftScore = left.placementCount / Math.max(left.maxNodes, 1);
			const rightScore = right.placementCount / Math.max(right.maxNodes, 1);
			return (
				leftScore - rightScore ||
				left.regionSlug.localeCompare(right.regionSlug) ||
				left.clusterSlug.localeCompare(right.clusterSlug) ||
				(left.nodePoolName ?? "").localeCompare(right.nodePoolName ?? "")
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
	const clusters = await db.query.platformClusters.findMany({
		where: and(
			eq(platformClusters.runtime, "kubernetes"),
			eq(platformClusters.status, "active"),
		),
		with: {
			region: true,
			nodePools: true,
			placements: { columns: { placementId: true, nodePoolId: true } },
		},
	});

	return clusters.flatMap<KubernetesPlacementCandidate>((cluster) => {
		if (cluster.region.status !== "active") return [];
		const runtimePools = cluster.nodePools.filter(
			(pool) => pool.purpose === "runtime" && pool.status === "active",
		);
		if (runtimePools.length === 0) {
			return [
				{
					clusterId: cluster.clusterId,
					clusterSlug: cluster.slug,
					regionId: cluster.regionId,
					regionSlug: cluster.region.slug,
					nodePoolId: null,
					nodePoolName: null,
					placementCount: cluster.placements.length,
					maxNodes: 1,
				},
			];
		}
		return runtimePools.map((pool) => ({
			clusterId: cluster.clusterId,
			clusterSlug: cluster.slug,
			regionId: cluster.regionId,
			regionSlug: cluster.region.slug,
			nodePoolId: pool.nodePoolId,
			nodePoolName: pool.name,
			placementCount: cluster.placements.filter(
				(placement) => placement.nodePoolId === pool.nodePoolId,
			).length,
			maxNodes: pool.maxNodes,
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

	const candidate = selectKubernetesPlacementCandidate(
		await getKubernetesPlacementCandidates(),
		preferredRegion,
	);
	if (!candidate) return null;

	const [placement] = await db
		.insert(platformPlacements)
		.values({
			applicationId,
			organizationId,
			clusterId: candidate.clusterId,
			nodePoolId: candidate.nodePoolId,
			runtime: "kubernetes",
			namespace: buildApplicationNamespace(organizationId, applicationId),
			desiredReplicas: Math.max(desiredReplicas, 1),
		})
		.onConflictDoNothing({ target: platformPlacements.applicationId })
		.returning();

	return (
		placement ??
		(await db.query.platformPlacements.findFirst({
			where: eq(platformPlacements.applicationId, applicationId),
		})) ??
		null
	);
};

export const findApplicationPlatformPlacement = async (applicationId: string) =>
	(await db.query.platformPlacements.findFirst({
		where: eq(platformPlacements.applicationId, applicationId),
		with: {
			cluster: { with: { region: true } },
			nodePool: true,
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
				"Create Kubernetes clusters in provisioning state, add build/runtime node pools, then activate them",
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
		const pools = await db.query.platformNodePools.findMany({
			where: and(
				eq(platformNodePools.clusterId, clusterId),
				eq(platformNodePools.status, "active"),
			),
			columns: { purpose: true },
		});
		if (
			!pools.some((pool) => pool.purpose === "runtime") ||
			!pools.some((pool) => pool.purpose === "build")
		) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message:
					"Kubernetes clusters require active runtime and build node pools",
			});
		}
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
		!cluster.metadata.builderImage?.includes("@sha256:")
			? "immutable builderImage"
			: null,
		!cluster.metadata.buildRuntimeClassName ? "buildRuntimeClassName" : null,
		!cluster.metadata.runtimeClassName ? "runtimeClassName" : null,
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
				with: { nodePools: true, placements: true },
			},
		},
	});
	return regions.map((region) => ({
		...region,
		clusters: region.clusters.map((cluster) => redactPlatformCluster(cluster)),
	}));
};

export const redactPlatformCluster = <
	T extends PlatformCluster & { metadata: PlatformClusterMetadata },
>(
	cluster: T,
) => ({ ...cluster, kubeconfig: cluster.kubeconfig ? "[REDACTED]" : null });
