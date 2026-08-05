import { db } from "@dokploy/server/db";
import { platformPlacements } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
import {
	findVerifiedDomainsByApplicationId,
	isPlatformManagedHostname,
} from "./domain-verification";
import { createKubernetesControlPlane } from "./kubernetes/client";
import {
	buildKubernetesHpaManifest,
	buildKubernetesRoutingManifests,
	kubernetesApplicationResourceName,
} from "./kubernetes/manifests";
import { findApplicationPlatformPlacement } from "./platform-infrastructure";

export interface PlatformRuntimeController {
	restart(): Promise<void>;
	stop(): Promise<void>;
	start(): Promise<void>;
	delete(): Promise<void>;
}

export const resolvePlatformRuntimeController = async (
	applicationId: string,
	appName: string,
): Promise<PlatformRuntimeController | null> => {
	const placement = await findApplicationPlatformPlacement(applicationId);
	if (!placement) return null;
	const { runtimeTarget } = placement;
	const { cluster } = runtimeTarget;
	if (
		runtimeTarget.runtime !== "kubernetes" ||
		cluster.runtime !== "kubernetes"
	) {
		throw new Error("Placement runtime does not match its cluster");
	}
	const client = createKubernetesControlPlane({
		kubeconfig: cluster.kubeconfig,
		inCluster: cluster.metadata.inCluster,
	});
	const name = kubernetesApplicationResourceName(applicationId);
	const hpaIdentity = {
		apiVersion: "autoscaling/v2",
		kind: "HorizontalPodAutoscaler",
		metadata: { name, namespace: placement.namespace },
	};
	const updateStatus = async (
		status: "pending" | "active" | "draining" | "failed",
	) => {
		await db
			.update(platformPlacements)
			.set({ status, updatedAt: new Date() })
			.where(eq(platformPlacements.placementId, placement.placementId));
	};
	return {
		restart: async () => {
			await client.restartDeployment(placement.namespace, name);
			await updateStatus("pending");
		},
		stop: async () => {
			await client.delete(hpaIdentity);
			await client.setDeploymentReplicas(placement.namespace, name, 0);
			await updateStatus("draining");
		},
		start: async () => {
			await client.setDeploymentReplicas(
				placement.namespace,
				name,
				Math.max(placement.desiredReplicas, 1),
			);
			await client.apply([
				buildKubernetesHpaManifest({
					applicationId: placement.applicationId,
					organizationId: placement.organizationId,
					appName,
					namespace: placement.namespace,
					minReplicas: Math.max(placement.desiredReplicas, 1),
					maxReplicas: Math.max(
						Number.parseInt(
							process.env.PLATFORM_KUBERNETES_MAX_REPLICAS || "3",
							10,
						),
						placement.desiredReplicas,
					),
					targetCpuUtilization: Number.parseInt(
						process.env.PLATFORM_KUBERNETES_TARGET_CPU_PERCENT || "70",
						10,
					),
				}),
			]);
			await updateStatus("pending");
		},
		delete: async () => {
			const gatewayNamespace = cluster.metadata.gatewayNamespace;
			if (
				gatewayNamespace &&
				(cluster.metadata.gatewayMode === "dedicated" ||
					cluster.metadata.gatewayMode === "hybrid" ||
					cluster.metadata.gatewayMode === undefined)
			) {
				await Promise.all([
					client.delete({
						apiVersion: "gateway.networking.k8s.io/v1",
						kind: "Gateway",
						metadata: { name: `${name}-gateway`, namespace: gatewayNamespace },
					}),
					client.delete({
						apiVersion: "cert-manager.io/v1",
						kind: "Certificate",
						metadata: { name: `${name}-tls`, namespace: gatewayNamespace },
					}),
				]);
			}
			await client.deleteNamespace(placement.namespace);
		},
	};
};

export const reconcilePlatformDomainRoutes = async ({
	applicationId,
	appName,
	port,
}: {
	applicationId: string;
	appName: string;
	port: number;
}) => {
	const placement = await findApplicationPlatformPlacement(applicationId);
	if (!placement || placement.runtimeTarget.runtime !== "kubernetes")
		return false;
	const metadata = placement.runtimeTarget.cluster.metadata;
	if (!metadata.gatewayNamespace || !metadata.gatewayName) return false;
	const client = createKubernetesControlPlane({
		kubeconfig: placement.runtimeTarget.cluster.kubeconfig,
		inCluster: metadata.inCluster,
	});
	const verifiedDomains =
		await findVerifiedDomainsByApplicationId(applicationId);
	const configuredGatewayMode = metadata.gatewayMode ?? "hybrid";
	const gatewayMode =
		configuredGatewayMode === "hybrid"
			? verifiedDomains.every((domain) =>
					isPlatformManagedHostname(domain.host),
				)
				? "shared"
				: "dedicated"
			: configuredGatewayMode;
	const name = kubernetesApplicationResourceName(applicationId);
	const routeIdentity = {
		apiVersion: "gateway.networking.k8s.io/v1",
		kind: "HTTPRoute",
		metadata: { name, namespace: placement.namespace },
	};
	const gatewayIdentity = {
		apiVersion: "gateway.networking.k8s.io/v1",
		kind: "Gateway",
		metadata: {
			name: `${name}-gateway`,
			namespace: metadata.gatewayNamespace,
		},
	};
	const certificateIdentity = {
		apiVersion: "cert-manager.io/v1",
		kind: "Certificate",
		metadata: {
			name: `${name}-tls`,
			namespace: metadata.gatewayNamespace,
		},
	};
	const routing = buildKubernetesRoutingManifests({
		applicationId,
		organizationId: placement.organizationId,
		appName,
		namespace: placement.namespace,
		gateway: {
			namespace: metadata.gatewayNamespace,
			name: metadata.gatewayName,
			sectionName: metadata.gatewaySectionName,
			className: metadata.gatewayClassName,
			certIssuerName: metadata.certIssuerName,
			mode: gatewayMode,
			podSelector: metadata.gatewayPodSelector,
			externalDns: {
				enabled: metadata.externalDnsEnabled === true,
				target: metadata.externalDnsTarget,
				ttl: metadata.externalDnsTtl,
			},
		},
		domains: verifiedDomains,
		port,
	});
	if (routing.length > 0) {
		await client.apply(routing);
		if (gatewayMode === "shared") {
			await Promise.all([
				client.delete(gatewayIdentity),
				client.delete(certificateIdentity),
			]);
		}
	} else {
		await Promise.all([
			client.delete(routeIdentity),
			client.delete(gatewayIdentity),
			client.delete(certificateIdentity),
		]);
	}
	return true;
};
