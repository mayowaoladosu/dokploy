import type {
	PlatformClusterMetadata,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { removeTraefikConfig } from "@dokploy/server/utils/traefik/application";
import { findVerifiedDomainsByApplicationId } from "./domain-verification";
import type { KubernetesControlPlane } from "./kubernetes/client";
import {
	buildKubernetesRoutingManifests,
	kubernetesApplicationResourceName,
	kubernetesReleaseNamespace,
} from "./kubernetes/manifests";
import type { ReleaseApplication, ReleaseDomain } from "./release-types";

export type EdgePublication = {
	provider: string;
	domains: string[];
	publishedAt: string;
};

export interface EdgeRouter {
	readonly provider: string;
	publish(input: {
		releaseId: string;
		deploymentId: string;
		application: ReleaseApplication;
	}): Promise<EdgePublication>;
	withdraw(input: { application: ReleaseApplication }): Promise<void>;
}

const domainsFor = async (
	application: ReleaseApplication,
): Promise<ReleaseDomain[]> =>
	application.releaseDomains ??
	(await findVerifiedDomainsByApplicationId(application.applicationId)).map(
		(domain) => ({ ...domain, https: true }),
	);

/** Swarm routing remains owned by its Traefik adapter and domain lifecycle. */
export const createSwarmEdgeRouter = (): EdgeRouter => ({
	provider: "traefik",
	publish: async ({ application }) => ({
		provider: "traefik",
		domains: (application.releaseDomains ?? application.domains ?? []).map(
			(domain) => domain.host,
		),
		publishedAt: new Date().toISOString(),
	}),
	withdraw: async ({ application }) =>
		removeTraefikConfig(application.appName, application.serverId),
});

export const createKubernetesEdgeRouter = ({
	client,
	placement,
	clusterMetadata,
}: {
	client: KubernetesControlPlane;
	placement: PlatformPlacement;
	clusterMetadata: PlatformClusterMetadata;
}): EdgeRouter => {
	const identityFor = (application: ReleaseApplication) =>
		application.releaseIdentity || application.applicationId;
	const deleteRoutes = async (application: ReleaseApplication) => {
		const identity = identityFor(application);
		const name = kubernetesApplicationResourceName(identity);
		const namespace = kubernetesReleaseNamespace({
			applicationId: application.applicationId,
			releaseIdentity: application.releaseIdentity,
			placementNamespace: placement.namespace,
		});
		const gatewayNamespace = clusterMetadata.gatewayNamespace;
		await client.delete({
			apiVersion: "gateway.networking.k8s.io/v1",
			kind: "HTTPRoute",
			metadata: { name, namespace },
		});
		if (gatewayNamespace) {
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
	};

	return {
		provider: "kubernetes-gateway-api",
		publish: async ({ application }) => {
			const domains = await domainsFor(application);
			if (
				domains.length === 0 ||
				!clusterMetadata.gatewayNamespace ||
				!clusterMetadata.gatewayName
			) {
				await deleteRoutes(application);
				return {
					provider: "kubernetes-gateway-api",
					domains: [],
					publishedAt: new Date().toISOString(),
				};
			}
			const identity = identityFor(application);
			const namespace = kubernetesReleaseNamespace({
				applicationId: application.applicationId,
				releaseIdentity: application.releaseIdentity,
				placementNamespace: placement.namespace,
			});
			const port = application.ports[0]?.targetPort ?? 3000;
			await client.apply(
				buildKubernetesRoutingManifests({
					applicationId: identity,
					organizationId: application.environment.project.organizationId,
					appName: application.appName,
					namespace,
					gateway: {
						namespace: clusterMetadata.gatewayNamespace,
						name: clusterMetadata.gatewayName,
						sectionName: clusterMetadata.gatewaySectionName,
						className: clusterMetadata.gatewayClassName,
						certIssuerName: clusterMetadata.certIssuerName,
					},
					domains,
					port,
				}),
			);
			return {
				provider: "kubernetes-gateway-api",
				domains: domains.map((domain) => domain.host),
				publishedAt: new Date().toISOString(),
			};
		},
		withdraw: ({ application }) => deleteRoutes(application),
	};
};
