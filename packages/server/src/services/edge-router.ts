import type {
	PlatformClusterMetadata,
	PlatformPlacement,
} from "@dokploy/server/db/schema";
import { removeTraefikConfig } from "@dokploy/server/utils/traefik/application";
import {
	findVerifiedDomainsByApplicationId,
	isPlatformManagedHostname,
} from "./domain-verification";
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
	pollIntervalMs = 1_000,
	routeTimeoutMs = 120_000,
	originProtection,
	sleep = (durationMs: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
}: {
	client: KubernetesControlPlane;
	placement: PlatformPlacement;
	clusterMetadata: PlatformClusterMetadata;
	pollIntervalMs?: number;
	routeTimeoutMs?: number;
	originProtection?: { headerName: string; headerValue: string };
	sleep?: (durationMs: number) => Promise<void>;
}): EdgeRouter => {
	const identityFor = (application: ReleaseApplication) =>
		application.releaseIdentity || application.applicationId;
	const deleteDedicatedGateway = async (name: string) => {
		if (!clusterMetadata.gatewayNamespace) return;
		await Promise.all([
			client.delete({
				apiVersion: "gateway.networking.k8s.io/v1",
				kind: "Gateway",
				metadata: {
					name: `${name}-gateway`,
					namespace: clusterMetadata.gatewayNamespace,
				},
			}),
			client.delete({
				apiVersion: "cert-manager.io/v1",
				kind: "Certificate",
				metadata: {
					name: `${name}-tls`,
					namespace: clusterMetadata.gatewayNamespace,
				},
			}),
		]);
	};
	const deleteRoutes = async (application: ReleaseApplication) => {
		const identity = identityFor(application);
		const name = kubernetesApplicationResourceName(identity);
		const namespace = kubernetesReleaseNamespace({
			applicationId: application.applicationId,
			releaseIdentity: application.releaseIdentity,
			placementNamespace: placement.namespace,
		});
		await client.delete({
			apiVersion: "gateway.networking.k8s.io/v1",
			kind: "HTTPRoute",
			metadata: { name, namespace },
		});
		if (
			clusterMetadata.gatewayNamespace &&
			(clusterMetadata.gatewayMode === "dedicated" ||
				clusterMetadata.gatewayMode === "hybrid" ||
				clusterMetadata.gatewayMode === undefined)
		) {
			await deleteDedicatedGateway(name);
		}
	};
	const waitForRouteAcceptance = async (namespace: string, name: string) => {
		const deadline = Date.now() + routeTimeoutMs;
		while (Date.now() < deadline) {
			const route = (await client.read({
				apiVersion: "gateway.networking.k8s.io/v1",
				kind: "HTTPRoute",
				metadata: { name, namespace },
			})) as {
				status?: {
					parents?: Array<{
						conditions?: Array<{
							type?: string;
							status?: string;
							message?: string;
						}>;
					}>;
				};
			} | null;
			const conditions =
				route?.status?.parents?.flatMap((parent) => parent.conditions ?? []) ??
				[];
			const rejected = conditions.find(
				(condition) =>
					(condition.type === "Accepted" ||
						condition.type === "ResolvedRefs") &&
					condition.status === "False",
			);
			if (rejected) {
				throw new Error(
					rejected.message || `Gateway API rejected route ${namespace}/${name}`,
				);
			}
			if (
				conditions.some(
					(condition) =>
						condition.type === "Accepted" && condition.status === "True",
				)
			) {
				return;
			}
			await sleep(pollIntervalMs);
		}
		throw new Error(
			`Gateway API route ${namespace}/${name} was not accepted within ${routeTimeoutMs}ms`,
		);
	};

	const waitForResourceCondition = async ({
		apiVersion,
		kind,
		name,
		namespace,
		conditionType,
	}: {
		apiVersion: string;
		kind: string;
		name: string;
		namespace: string;
		conditionType: string;
	}) => {
		const deadline = Date.now() + routeTimeoutMs;
		while (Date.now() < deadline) {
			const resource = (await client.read({
				apiVersion,
				kind,
				metadata: { name, namespace },
			})) as {
				status?: {
					conditions?: Array<{
						type?: string;
						status?: string;
						message?: string;
					}>;
				};
			} | null;
			const condition = resource?.status?.conditions?.find(
				(candidate) => candidate.type === conditionType,
			);
			if (condition?.status === "True") return;
			if (condition?.status === "False") {
				throw new Error(
					condition.message || `${kind} ${namespace}/${name} is not ready`,
				);
			}
			await sleep(pollIntervalMs);
		}
		throw new Error(
			`${kind} ${namespace}/${name} did not reach ${conditionType} within ${routeTimeoutMs}ms`,
		);
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
			const port =
				application.ports.find((candidate) => candidate.protocol !== "udp")
					?.targetPort ?? (application.ports.length === 0 ? 3000 : undefined);
			if (!port) {
				throw new Error("Gateway HTTP routing requires at least one TCP port");
			}
			const configuredGatewayMode = clusterMetadata.gatewayMode ?? "hybrid";
			const gatewayMode =
				configuredGatewayMode === "hybrid"
					? domains.every((domain) => isPlatformManagedHostname(domain.host))
						? "shared"
						: "dedicated"
					: configuredGatewayMode;
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
						mode: gatewayMode,
						podSelector: clusterMetadata.gatewayPodSelector,
						externalDns: {
							enabled: clusterMetadata.externalDnsEnabled === true,
							target: clusterMetadata.externalDnsTarget,
							ttl: clusterMetadata.externalDnsTtl,
						},
						requiredHeaders: originProtection
							? {
									[originProtection.headerName]: originProtection.headerValue,
								}
							: undefined,
					},
					domains,
					port,
				}),
			);
			if (gatewayMode === "dedicated") {
				const resourceName = kubernetesApplicationResourceName(identity);
				await Promise.all([
					waitForResourceCondition({
						apiVersion: "gateway.networking.k8s.io/v1",
						kind: "Gateway",
						name: `${resourceName}-gateway`,
						namespace: clusterMetadata.gatewayNamespace,
						conditionType: "Programmed",
					}),
					waitForResourceCondition({
						apiVersion: "cert-manager.io/v1",
						kind: "Certificate",
						name: `${resourceName}-tls`,
						namespace: clusterMetadata.gatewayNamespace,
						conditionType: "Ready",
					}),
				]);
			} else {
				await waitForResourceCondition({
					apiVersion: "gateway.networking.k8s.io/v1",
					kind: "Gateway",
					name: clusterMetadata.gatewayName,
					namespace: clusterMetadata.gatewayNamespace,
					conditionType: "Programmed",
				});
			}
			await waitForRouteAcceptance(
				namespace,
				kubernetesApplicationResourceName(identity),
			);
			if (gatewayMode === "shared") {
				await deleteDedicatedGateway(
					kubernetesApplicationResourceName(identity),
				);
			}
			return {
				provider: "kubernetes-gateway-api",
				domains: domains.map((domain) => domain.host),
				publishedAt: new Date().toISOString(),
			};
		},
		withdraw: ({ application }) => deleteRoutes(application),
	};
};
