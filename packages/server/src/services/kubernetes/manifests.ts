import { createHash } from "node:crypto";
import type { KubernetesObject } from "@kubernetes/client-node";
import { quote } from "shell-quote";
import { buildOutputDiscoveryShell } from "../build-output-manifest";
import { buildKubernetesControlPlaneRoleBinding } from "./control-plane-rbac";

export type KubernetesManifest = KubernetesObject & Record<string, unknown>;

export type KubernetesDomainRoute = {
	host: string;
	path?: string | null;
};

export type KubernetesPort = {
	targetPort: number;
	protocol?: "tcp" | "udp";
};

export type KubernetesHealthCheck = {
	protocol: "http" | "https" | "tcp";
	port: number;
	path?: string;
	periodSeconds?: number;
	timeoutSeconds?: number;
	failureThreshold?: number;
	startupFailureThreshold?: number;
};

export type KubernetesResourceSpec = {
	memoryLimitBytes: number;
	memoryRequestBytes: number;
	cpuLimitNano: number;
	cpuRequestNano: number;
	ephemeralStorageLimitBytes?: number;
	ephemeralStorageRequestBytes?: number;
};

export type KubernetesPlacementSpec = {
	applicationId: string;
	billingApplicationId?: string;
	organizationId: string;
	appName: string;
	namespace: string;
	imageRef: string;
	replicas: number;
	maxReplicas: number;
	targetCpuUtilization: number;
	environment: string[];
	ports: KubernetesPort[];
	resources: KubernetesResourceSpec;
	command?: string[];
	args?: string[] | null;
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: Array<{
		key: string;
		value?: string;
		effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
	}>;
	registrySecretName?: string;
	registryCredentials?: {
		server: string;
		username: string;
		password: string;
	};
	healthCheck?: KubernetesHealthCheck;
	terminationGracePeriodSeconds?: number;
	multiZone?: boolean;
	readOnlyRootFilesystem?: boolean;
	gateway?: {
		namespace: string;
		dataPlaneNamespace?: string;
		name: string;
		sectionName?: string;
		className?: string;
		certIssuerName?: string;
		mode?: "shared" | "dedicated";
		podSelector?: Record<string, string>;
		externalDns?: {
			enabled: boolean;
			target?: string;
			ttl?: number;
		};
		requiredHeaders?: Record<string, string>;
	};
	domains: KubernetesDomainRoute[];
	allowedEgressCidrs?: string[];
	observability?: {
		endpoint: string;
		namespace: string;
		organizationId: string;
		applicationId: string;
		serviceName: string;
	};
};

export type KubernetesBuildJobSpec = {
	applicationId: string;
	organizationId: string;
	deploymentId: string;
	namespace: string;
	appName: string;
	builderImage: string;
	sourceCommand: string;
	buildCommand: string;
	sourceRunsInBuilder: boolean;
	localImageRef: string;
	workspacePath: string;
	publishDirectory?: string | null;
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: KubernetesPlacementSpec["tolerations"];
	activeDeadlineSeconds: number;
	resources: KubernetesResourceSpec;
	artifactStorageClassName: string;
	sourceSecrets: Record<string, string>;
	buildSecrets: Record<string, string>;
	registryCredentials?: NonNullable<
		KubernetesPlacementSpec["registryCredentials"]
	>;
	allowedEgressCidrs?: string[];
};

export type KubernetesPublisherJobSpec = {
	applicationId: string;
	organizationId: string;
	deploymentId: string;
	namespace: string;
	publisherImage: string;
	runtimeImageRef: string;
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: KubernetesPlacementSpec["tolerations"];
	serviceAccountAnnotations?: Record<string, string>;
	podLabels?: Record<string, string>;
	podAnnotations?: Record<string, string>;
	activeDeadlineSeconds: number;
	resources: KubernetesResourceSpec;
	registrySecrets: Record<string, string>;
	registryCredentials?: NonNullable<
		KubernetesPlacementSpec["registryCredentials"]
	>;
};

export type KubernetesSupplyChainJobSpec = {
	applicationId: string;
	organizationId: string;
	deploymentId: string;
	namespace: string;
	verifierImage: string;
	imageRef: string;
	signingKeyRef: string;
	maxCriticalVulnerabilities: number;
	maxHighVulnerabilities: number;
	ignoreUnfixed: boolean;
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: KubernetesPlacementSpec["tolerations"];
	serviceAccountAnnotations?: Record<string, string>;
	podLabels?: Record<string, string>;
	podAnnotations?: Record<string, string>;
	activeDeadlineSeconds: number;
	resources: KubernetesResourceSpec;
	registrySecrets: Record<string, string>;
	signingSecrets?: Record<string, string>;
	registryCredentials?: NonNullable<
		KubernetesPlacementSpec["registryCredentials"]
	>;
};

export type KubernetesOutputPublisherJobSpec = {
	applicationId: string;
	organizationId: string;
	deploymentId: string;
	namespace: string;
	publisherImage: string;
	manifestDigest: string;
	objectPrefix: string;
	publicBaseUrl: string;
	storageProvider: "r2" | "s3";
	storageEndpoint: string;
	storageRegion: string;
	storageBucket: string;
	storageAccessKeyId: string;
	storageSecretAccessKey: string;
	serverSideEncryption?: "AES256" | "aws:kms";
	kmsKeyId?: string;
	cacheControl?: string;
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: KubernetesPlacementSpec["tolerations"];
	serviceAccountAnnotations?: Record<string, string>;
	podLabels?: Record<string, string>;
	podAnnotations?: Record<string, string>;
	activeDeadlineSeconds: number;
	resources: KubernetesResourceSpec;
	registryCredentials?: NonNullable<
		KubernetesPlacementSpec["registryCredentials"]
	>;
};

const k8sName = (value: string, maxLength = 63) => {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-+/g, "-");
	if (normalized.length <= maxLength) return normalized || "vlyv-resource";
	const digest = createHash("sha256").update(value).digest("hex").slice(0, 8);
	return `${normalized.slice(0, maxLength - digest.length - 1)}-${digest}`;
};

export const kubernetesApplicationResourceName = (applicationId: string) =>
	k8sName(`app-${applicationId}`);

export const kubernetesReleaseNamespace = ({
	applicationId,
	releaseIdentity,
	placementNamespace,
}: {
	applicationId: string;
	releaseIdentity?: string;
	placementNamespace: string;
}) => {
	if (!releaseIdentity || releaseIdentity === applicationId) {
		return placementNamespace;
	}
	const digest = createHash("sha256")
		.update(releaseIdentity)
		.digest("hex")
		.slice(0, 12);
	return k8sName(`${placementNamespace}-release-${digest}`);
};

const labelsFor = (
	applicationId: string,
	organizationId: string,
	component: string,
) => ({
	"app.kubernetes.io/managed-by": "vlyv",
	"app.kubernetes.io/component": component,
	"vlyv.dev/application": createHash("sha256")
		.update(applicationId)
		.digest("hex")
		.slice(0, 16),
	"vlyv.dev/organization": createHash("sha256")
		.update(organizationId)
		.digest("hex")
		.slice(0, 16),
});

const bytesToMi = (bytes: number) =>
	`${Math.max(Math.ceil(bytes / 1_048_576), 1)}Mi`;
const nanoToMillicores = (nano: number) =>
	`${Math.max(Math.ceil(nano / 1_000_000), 1)}m`;

const envName = (entry: string) => entry.slice(0, entry.indexOf("=")).trim();
const envValue = (entry: string) => entry.slice(entry.indexOf("=") + 1);

const environmentToStringData = (entries: string[]) =>
	Object.fromEntries(
		entries
			.filter((entry) => entry.includes("="))
			.map((entry) => [envName(entry), envValue(entry)])
			.filter(([name]) => Boolean(name)),
	);

const secretData = (values: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(values).map(([name, value]) => [
			name,
			Buffer.from(value, "utf8").toString("base64"),
		]),
	);

const registryDockerConfig = ({
	server,
	username,
	password,
}: NonNullable<KubernetesPlacementSpec["registryCredentials"]>) =>
	Buffer.from(
		JSON.stringify({
			auths: {
				[server]: {
					username,
					password,
					auth: Buffer.from(`${username}:${password}`, "utf8").toString(
						"base64",
					),
				},
			},
		}),
		"utf8",
	).toString("base64");

const probeFor = (
	healthCheck: KubernetesHealthCheck,
	kind: "startup" | "readiness" | "liveness",
) => {
	const periodSeconds = Math.max(healthCheck.periodSeconds ?? 5, 1);
	const endpoint =
		healthCheck.protocol === "tcp"
			? { tcpSocket: { port: healthCheck.port } }
			: {
					httpGet: {
						path: healthCheck.path || "/",
						port: healthCheck.port,
						scheme: healthCheck.protocol.toUpperCase(),
					},
				};
	return {
		...endpoint,
		periodSeconds,
		timeoutSeconds: Math.max(healthCheck.timeoutSeconds ?? 2, 1),
		failureThreshold:
			kind === "startup"
				? Math.max(healthCheck.startupFailureThreshold ?? 60, 1)
				: Math.max(healthCheck.failureThreshold ?? 3, 1),
		...(kind === "readiness" ? { successThreshold: 1 } : {}),
	};
};

const workloadResources = (resources: KubernetesResourceSpec) => ({
	limits: {
		memory: bytesToMi(resources.memoryLimitBytes),
		cpu: nanoToMillicores(resources.cpuLimitNano),
		...(resources.ephemeralStorageLimitBytes
			? {
					"ephemeral-storage": bytesToMi(resources.ephemeralStorageLimitBytes),
				}
			: {}),
	},
	requests: {
		memory: bytesToMi(resources.memoryRequestBytes),
		cpu: nanoToMillicores(resources.cpuRequestNano),
		...(resources.ephemeralStorageRequestBytes
			? {
					"ephemeral-storage": bytesToMi(
						resources.ephemeralStorageRequestBytes,
					),
				}
			: {}),
	},
});

const buildEgressPolicyManifests = (
	namespace: string,
	allowedEgressCidrs: string[] = [],
	observabilityNamespace?: string,
): KubernetesManifest[] => [
	{
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: { name: "default-deny-egress", namespace },
		spec: { podSelector: {}, policyTypes: ["Egress"], egress: [] },
	},
	{
		apiVersion: "networking.k8s.io/v1",
		kind: "NetworkPolicy",
		metadata: { name: "allow-dns-and-public-egress", namespace },
		spec: {
			podSelector: {},
			policyTypes: ["Egress"],
			egress: [
				{
					to: [
						{
							namespaceSelector: {
								matchLabels: {
									"kubernetes.io/metadata.name": "kube-system",
								},
							},
							podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
						},
					],
					ports: [
						{ protocol: "UDP", port: 53 },
						{ protocol: "TCP", port: 53 },
					],
				},
				{
					to: [
						{
							ipBlock: {
								cidr: "0.0.0.0/0",
								except: [
									"0.0.0.0/8",
									"10.0.0.0/8",
									"100.64.0.0/10",
									"127.0.0.0/8",
									"169.254.0.0/16",
									"172.16.0.0/12",
									"192.0.0.0/24",
									"192.0.2.0/24",
									"192.168.0.0/16",
									"198.18.0.0/15",
									"198.51.100.0/24",
									"203.0.113.0/24",
									"224.0.0.0/4",
									"240.0.0.0/4",
								],
							},
						},
					],
				},
				{
					to: [
						{
							ipBlock: {
								cidr: "::/0",
								except: ["::/128", "::1/128", "fc00::/7", "fe80::/10"],
							},
						},
					],
				},
				...allowedEgressCidrs.map((cidr) => ({
					to: [{ ipBlock: { cidr } }],
				})),
				...(observabilityNamespace
					? [
							{
								to: [
									{
										namespaceSelector: {
											matchLabels: {
												"kubernetes.io/metadata.name": observabilityNamespace,
											},
										},
										podSelector: {
											matchLabels: {
												"app.kubernetes.io/name": "vlyv-otel-collector",
											},
										},
									},
								],
								ports: [
									{ protocol: "TCP", port: 4317 },
									{ protocol: "TCP", port: 4318 },
								],
							},
						]
					: []),
			],
		},
	},
];

export const buildKubernetesHttpRouteManifest = ({
	applicationId,
	organizationId,
	appName: _appName,
	namespace,
	gateway,
	domains,
	port,
}: {
	applicationId: string;
	organizationId: string;
	appName: string;
	namespace: string;
	gateway: NonNullable<KubernetesPlacementSpec["gateway"]>;
	domains: KubernetesDomainRoute[];
	port: number;
}): KubernetesManifest => {
	const name = kubernetesApplicationResourceName(applicationId);
	const externalDnsAnnotations = gateway.externalDns?.enabled
		? {
				"external-dns.alpha.kubernetes.io/hostname": domains
					.map((domain) => domain.host)
					.join(","),
				...(gateway.externalDns.target
					? {
							"external-dns.alpha.kubernetes.io/target":
								gateway.externalDns.target,
						}
					: {}),
				...(gateway.externalDns.ttl
					? {
							"external-dns.alpha.kubernetes.io/ttl": String(
								gateway.externalDns.ttl,
							),
						}
					: {}),
			}
		: undefined;
	return {
		apiVersion: "gateway.networking.k8s.io/v1",
		kind: "HTTPRoute",
		metadata: {
			name,
			namespace,
			labels: labelsFor(applicationId, organizationId, "runtime"),
			annotations: externalDnsAnnotations,
		},
		spec: {
			parentRefs: [
				{
					name: gateway.name,
					namespace: gateway.namespace,
					sectionName: gateway.sectionName,
				},
			],
			hostnames: domains.map((domain) => domain.host),
			rules: domains.map((domain) => ({
				matches: [
					{
						path: {
							type: "PathPrefix",
							value: domain.path || "/",
						},
						headers: gateway.requiredHeaders
							? Object.entries(gateway.requiredHeaders).map(
									([name, value]) => ({
										type: "Exact",
										name,
										value,
									}),
								)
							: undefined,
					},
				],
				backendRefs: [{ name, port }],
			})),
		},
	};
};

export const buildKubernetesRoutingManifests = ({
	applicationId,
	organizationId,
	appName: _appName,
	namespace,
	gateway,
	domains,
	port,
}: {
	applicationId: string;
	organizationId: string;
	appName: string;
	namespace: string;
	gateway: NonNullable<KubernetesPlacementSpec["gateway"]>;
	domains: KubernetesDomainRoute[];
	port: number;
}): KubernetesManifest[] => {
	if (domains.length === 0) return [];
	const name = kubernetesApplicationResourceName(applicationId);
	const labels = labelsFor(applicationId, organizationId, "routing");
	const gatewayMode = gateway.mode ?? "shared";
	if (gatewayMode === "shared") {
		return [
			buildKubernetesHttpRouteManifest({
				applicationId,
				organizationId,
				appName: _appName,
				namespace,
				gateway,
				domains,
				port,
			}),
		];
	}
	if (!gateway.className || !gateway.certIssuerName) {
		throw new Error(
			"Dedicated Gateways require a GatewayClass and cert-manager issuer",
		);
	}
	const gatewayName = `${name}-gateway`;
	const certificateName = `${name}-tls`;
	const secretName = `${name}-tls`;
	return [
		{
			apiVersion: "cert-manager.io/v1",
			kind: "Certificate",
			metadata: {
				name: certificateName,
				namespace: gateway.namespace,
				labels,
			},
			spec: {
				secretName,
				dnsNames: domains.map((domain) => domain.host),
				issuerRef: {
					name: gateway.certIssuerName,
					kind: "ClusterIssuer",
				},
			},
		},
		{
			apiVersion: "gateway.networking.k8s.io/v1",
			kind: "Gateway",
			metadata: {
				name: gatewayName,
				namespace: gateway.namespace,
				labels,
			},
			spec: {
				gatewayClassName: gateway.className,
				listeners: [
					{
						name: "https",
						protocol: "HTTPS",
						port: 443,
						tls: {
							mode: "Terminate",
							certificateRefs: [{ kind: "Secret", name: secretName }],
						},
						allowedRoutes: {
							namespaces: {
								from: "Selector",
								selector: {
									matchLabels: {
										"vlyv.dev/application": labels["vlyv.dev/application"],
									},
								},
							},
						},
					},
				],
			},
		},
		buildKubernetesHttpRouteManifest({
			applicationId,
			organizationId,
			appName: _appName,
			namespace,
			gateway: {
				namespace: gateway.namespace,
				name: gatewayName,
				sectionName: "https",
				externalDns: gateway.externalDns,
				requiredHeaders: gateway.requiredHeaders,
			},
			domains,
			port,
		}),
	];
};

export const buildKubernetesHpaManifest = ({
	applicationId,
	organizationId,
	appName: _appName,
	namespace,
	minReplicas,
	maxReplicas,
	targetCpuUtilization,
}: {
	applicationId: string;
	organizationId: string;
	appName: string;
	namespace: string;
	minReplicas: number;
	maxReplicas: number;
	targetCpuUtilization: number;
}): KubernetesManifest => {
	const name = kubernetesApplicationResourceName(applicationId);
	return {
		apiVersion: "autoscaling/v2",
		kind: "HorizontalPodAutoscaler",
		metadata: {
			name,
			namespace,
			labels: labelsFor(applicationId, organizationId, "runtime"),
		},
		spec: {
			scaleTargetRef: {
				apiVersion: "apps/v1",
				kind: "Deployment",
				name,
			},
			minReplicas: Math.max(minReplicas, 1),
			maxReplicas: Math.max(maxReplicas, minReplicas, 1),
			behavior: {
				scaleDown: {
					stabilizationWindowSeconds: 300,
					policies: [{ type: "Percent", value: 50, periodSeconds: 60 }],
				},
				scaleUp: {
					stabilizationWindowSeconds: 30,
					policies: [{ type: "Percent", value: 100, periodSeconds: 30 }],
				},
			},
			metrics: [
				{
					type: "Resource",
					resource: {
						name: "cpu",
						target: {
							type: "Utilization",
							averageUtilization: targetCpuUtilization,
						},
					},
				},
			],
		},
	};
};

export const buildKubernetesRuntimeManifests = (
	spec: KubernetesPlacementSpec,
): KubernetesManifest[] => {
	if (
		spec.observability &&
		(!/^[a-f0-9]{32}$/.test(spec.observability.organizationId) ||
			!/^[a-f0-9]{32}$/.test(spec.observability.applicationId))
	) {
		throw new Error("Observability resource identities must be opaque hashes");
	}
	const name = kubernetesApplicationResourceName(spec.applicationId);
	const labels = {
		...labelsFor(spec.applicationId, spec.organizationId, "runtime"),
		"vlyv.dev/billing-application": createHash("sha256")
			.update(spec.billingApplicationId || spec.applicationId)
			.digest("hex")
			.slice(0, 16),
		...(spec.observability
			? {
					"vlyv.dev/observability-app": spec.observability.applicationId,
				}
			: {}),
	};
	const secretName = `${name}-env`;
	const registrySecretName = spec.registryCredentials
		? spec.registrySecretName || `${name}-registry`
		: spec.registrySecretName;
	const ports = spec.ports.length > 0 ? spec.ports : [{ targetPort: 3000 }];
	const maxReplicas = Math.max(spec.maxReplicas, spec.replicas);
	const aggregateMultiplier = Math.max(maxReplicas, 1) + 1;
	const runtimeEnvironment = {
		...environmentToStringData(spec.environment),
		...(spec.observability
			? {
					OTEL_EXPORTER_OTLP_ENDPOINT: spec.observability.endpoint,
					OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
					OTEL_SERVICE_NAME: spec.observability.serviceName,
					OTEL_RESOURCE_ATTRIBUTES: `vlyv.organization.id=${spec.observability.organizationId},vlyv.application.id=${spec.observability.applicationId}`,
				}
			: {}),
	};
	const manifests: KubernetesManifest[] = [
		{
			apiVersion: "v1",
			kind: "Namespace",
			metadata: {
				name: spec.namespace,
				labels: {
					...labels,
					"app.kubernetes.io/managed-by": "vlyv",
					"vlyv.dev/managed": "true",
					...(spec.observability
						? {
								"vlyv.dev/observability-tenant":
									spec.observability.organizationId,
							}
						: {}),
					"pod-security.kubernetes.io/enforce": "restricted",
					"pod-security.kubernetes.io/audit": "restricted",
					"pod-security.kubernetes.io/warn": "restricted",
				},
			},
		},
		buildKubernetesControlPlaneRoleBinding(spec.namespace),
		{
			apiVersion: "v1",
			kind: "ResourceQuota",
			metadata: { name: "vlyv-runtime-quota", namespace: spec.namespace },
			spec: {
				hard: {
					"requests.cpu": nanoToMillicores(
						spec.resources.cpuRequestNano * aggregateMultiplier,
					),
					"requests.memory": bytesToMi(
						spec.resources.memoryRequestBytes * aggregateMultiplier,
					),
					...(spec.resources.ephemeralStorageRequestBytes
						? {
								"requests.ephemeral-storage": bytesToMi(
									spec.resources.ephemeralStorageRequestBytes *
										aggregateMultiplier,
								),
							}
						: {}),
					"limits.cpu": nanoToMillicores(
						spec.resources.cpuLimitNano * aggregateMultiplier,
					),
					"limits.memory": bytesToMi(
						spec.resources.memoryLimitBytes * aggregateMultiplier,
					),
					...(spec.resources.ephemeralStorageLimitBytes
						? {
								"limits.ephemeral-storage": bytesToMi(
									spec.resources.ephemeralStorageLimitBytes *
										aggregateMultiplier,
								),
							}
						: {}),
					pods: String(aggregateMultiplier + 4),
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "LimitRange",
			metadata: { name: "vlyv-runtime-limits", namespace: spec.namespace },
			spec: {
				limits: [
					{
						type: "Container",
						default: workloadResources(spec.resources).limits,
						defaultRequest: workloadResources(spec.resources).requests,
					},
				],
			},
		},
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: secretName, namespace: spec.namespace, labels },
			type: "Opaque",
			data: secretData(runtimeEnvironment),
		},
		...(spec.registryCredentials
			? [
					{
						apiVersion: "v1",
						kind: "Secret",
						metadata: {
							name: registrySecretName,
							namespace: spec.namespace,
							labels,
						},
						type: "kubernetes.io/dockerconfigjson",
						data: {
							".dockerconfigjson": registryDockerConfig(
								spec.registryCredentials,
							),
						},
					},
				]
			: []),
		{
			apiVersion: "v1",
			kind: "ServiceAccount",
			metadata: { name, namespace: spec.namespace, labels },
			automountServiceAccountToken: false,
		},
		{
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: { name: "default-deny-ingress", namespace: spec.namespace },
			spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] },
		},
		{
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: { name: "allow-runtime-ingress", namespace: spec.namespace },
			spec: {
				podSelector: { matchLabels: labels },
				policyTypes: ["Ingress"],
				ingress: [
					{ from: [{ podSelector: { matchLabels: labels } }] },
					...(spec.gateway
						? [
								{
									from: [
										{
											namespaceSelector: {
												matchLabels: {
													"kubernetes.io/metadata.name":
														spec.gateway.dataPlaneNamespace ||
														spec.gateway.namespace,
												},
											},
											...(spec.gateway.podSelector
												? {
														podSelector: {
															matchLabels: spec.gateway.podSelector,
														},
													}
												: {}),
										},
									],
								},
							]
						: []),
				],
			},
		},
		...buildEgressPolicyManifests(
			spec.namespace,
			spec.allowedEgressCidrs,
			spec.observability?.namespace,
		),
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				replicas: Math.max(spec.replicas, 1),
				minReadySeconds: 5,
				progressDeadlineSeconds: 300,
				revisionHistoryLimit: 3,
				strategy: {
					type: "RollingUpdate",
					rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
				},
				selector: { matchLabels: labels },
				template: {
					metadata: { labels },
					spec: {
						serviceAccountName: name,
						automountServiceAccountToken: false,
						terminationGracePeriodSeconds: Math.max(
							spec.terminationGracePeriodSeconds ?? 30,
							1,
						),
						runtimeClassName: spec.runtimeClassName || undefined,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						imagePullSecrets: registrySecretName
							? [{ name: registrySecretName }]
							: undefined,
						containers: [
							{
								name,
								image: spec.imageRef,
								imagePullPolicy: "IfNotPresent",
								ports: ports.map((port, index) => ({
									name: `port-${index}`,
									containerPort: port.targetPort,
									protocol: (port.protocol || "tcp").toUpperCase(),
								})),
								envFrom: [{ secretRef: { name: secretName } }],
								command: spec.command,
								args: spec.args ?? undefined,
								resources: workloadResources(spec.resources),
								startupProbe: spec.healthCheck
									? probeFor(spec.healthCheck, "startup")
									: undefined,
								readinessProbe: spec.healthCheck
									? probeFor(spec.healthCheck, "readiness")
									: undefined,
								livenessProbe: spec.healthCheck
									? probeFor(spec.healthCheck, "liveness")
									: undefined,
								securityContext: {
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
									readOnlyRootFilesystem: spec.readOnlyRootFilesystem ?? false,
								},
								volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
							},
						],
						volumes: [
							{
								name: "tmp",
								emptyDir: {
									sizeLimit: bytesToMi(
										spec.resources.ephemeralStorageLimitBytes || 2 * 1024 ** 3,
									),
								},
							},
						],
						topologySpreadConstraints: [
							{
								maxSkew: 1,
								topologyKey: "kubernetes.io/hostname",
								whenUnsatisfiable: "ScheduleAnyway",
								labelSelector: { matchLabels: labels },
							},
							...(spec.multiZone
								? [
										{
											maxSkew: 1,
											topologyKey: "topology.kubernetes.io/zone",
											whenUnsatisfiable: "ScheduleAnyway",
											labelSelector: { matchLabels: labels },
										},
									]
								: []),
						],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				type: "ClusterIP",
				selector: labels,
				ports: ports.map((port, index) => ({
					name: `port-${index}`,
					port: port.targetPort,
					targetPort: port.targetPort,
					protocol: (port.protocol || "tcp").toUpperCase(),
				})),
			},
		},
		{
			apiVersion: "policy/v1",
			kind: "PodDisruptionBudget",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				...(spec.replicas <= 1
					? { maxUnavailable: 1 }
					: { minAvailable: Math.max(spec.replicas - 1, 1) }),
				selector: { matchLabels: labels },
			},
		},
		buildKubernetesHpaManifest({
			applicationId: spec.applicationId,
			organizationId: spec.organizationId,
			appName: spec.appName,
			namespace: spec.namespace,
			minReplicas: spec.replicas,
			maxReplicas,
			targetCpuUtilization: spec.targetCpuUtilization,
		}),
	];

	if (spec.gateway && spec.domains.length > 0) {
		const routePort = ports.find((port) => port.protocol !== "udp")?.targetPort;
		if (!routePort) {
			throw new Error("Gateway HTTP routing requires at least one TCP port");
		}
		manifests.push(
			...buildKubernetesRoutingManifests({
				applicationId: spec.applicationId,
				organizationId: spec.organizationId,
				appName: spec.appName,
				namespace: spec.namespace,
				gateway: spec.gateway,
				domains: spec.domains,
				port: routePort,
			}),
		);
	}

	return manifests;
};

export const buildKubernetesBuildManifests = (
	spec: KubernetesBuildJobSpec,
): KubernetesManifest[] => {
	const name = k8sName(`build-${spec.deploymentId}`);
	const labels = labelsFor(spec.applicationId, spec.organizationId, "build");
	const artifactClaimName = `${name}-artifacts`;
	const sourceSecretName = `${name}-source`;
	const buildSecretName = `${name}-environment`;
	const localImage = quote([spec.localImageRef]);
	const outputDiscovery = buildOutputDiscoveryShell({
		workspace: spec.workspacePath,
		publishDirectory: spec.publishDirectory,
	});
	const builderScript = `
set -e
export HOME=/home/builder
export XDG_RUNTIME_DIR=/tmp/docker-runtime
export DOCKER_HOST=unix:///tmp/docker-runtime/docker.sock
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
mkdir -p /etc/dokploy/ssh /etc/dokploy/applications /etc/dokploy/patch-repos
for tool in node base64 jq sha256sum find tar docker; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "Required managed builder tool is unavailable: $tool"
		exit 1
	fi
done
dockerd-rootless.sh --host="$DOCKER_HOST" --storage-driver=fuse-overlayfs > /tmp/dockerd.log 2>&1 &
for attempt in $(seq 1 60); do
	if docker info >/dev/null 2>&1; then break; fi
	if [ "$attempt" -eq 60 ]; then cat /tmp/dockerd.log; exit 1; fi
	sleep 1
done
${spec.sourceRunsInBuilder ? spec.sourceCommand : ""}
${spec.buildCommand}
${outputDiscovery}
image_id=$(docker image inspect --format '{{.Id}}' ${localImage})
image_size=$(docker image inspect --format '{{.Size}}' ${localImage})
output_manifest_digest="sha256:$(sha256sum /artifacts/output-manifest.json | cut -d ' ' -f 1)"
output_file_count=$(jq -er '.staticOutput.fileCount' /artifacts/output-manifest.json)
output_total_bytes=$(jq -er '.staticOutput.totalBytes' /artifacts/output-manifest.json)
docker save --output /artifacts/image.tar ${localImage}
printf '{"imageId":"%s","imageSizeBytes":%s,"outputManifestDigest":"%s","outputFileCount":%s,"outputTotalBytes":%s}' "$image_id" "$image_size" "$output_manifest_digest" "$output_file_count" "$output_total_bytes" >/artifacts/image.json
cat /artifacts/image.json >/dev/termination-log
`;
	return [
		{
			apiVersion: "v1",
			kind: "Namespace",
			metadata: {
				name: spec.namespace,
				labels: {
					"app.kubernetes.io/managed-by": "vlyv",
					"vlyv.dev/managed": "true",
					// The non-root builder needs nested user/mount namespaces and the
					// host TUN character device for RootlessKit networking. The
					// container itself remains UID 1000 with only SETUID/SETGID.
					"pod-security.kubernetes.io/enforce": "privileged",
					"pod-security.kubernetes.io/audit": "restricted",
					"pod-security.kubernetes.io/warn": "restricted",
				},
			},
		},
		buildKubernetesControlPlaneRoleBinding(spec.namespace),
		{
			apiVersion: "v1",
			kind: "ResourceQuota",
			metadata: { name: "vlyv-build-quota", namespace: spec.namespace },
			spec: {
				hard: {
					"requests.cpu": nanoToMillicores(spec.resources.cpuRequestNano),
					"requests.memory": bytesToMi(spec.resources.memoryRequestBytes),
					...(spec.resources.ephemeralStorageRequestBytes
						? {
								"requests.ephemeral-storage": bytesToMi(
									spec.resources.ephemeralStorageRequestBytes,
								),
							}
						: {}),
					"limits.cpu": nanoToMillicores(spec.resources.cpuLimitNano),
					"limits.memory": bytesToMi(spec.resources.memoryLimitBytes),
					...(spec.resources.ephemeralStorageLimitBytes
						? {
								"limits.ephemeral-storage": bytesToMi(
									spec.resources.ephemeralStorageLimitBytes,
								),
							}
						: {}),
					pods: "2",
					"count/jobs.batch": "3",
					persistentvolumeclaims: "1",
					"requests.storage": bytesToMi(
						spec.resources.ephemeralStorageLimitBytes || 20 * 1024 ** 3,
					),
				},
			},
		},
		{
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: { name: "default-deny-ingress", namespace: spec.namespace },
			spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] },
		},
		...buildEgressPolicyManifests(spec.namespace, spec.allowedEgressCidrs),
		{
			apiVersion: "v1",
			kind: "PersistentVolumeClaim",
			metadata: { name: artifactClaimName, namespace: spec.namespace, labels },
			spec: {
				accessModes: ["ReadWriteOnce"],
				storageClassName: spec.artifactStorageClassName,
				resources: {
					requests: {
						storage: bytesToMi(
							spec.resources.ephemeralStorageLimitBytes || 20 * 1024 ** 3,
						),
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: sourceSecretName, namespace: spec.namespace, labels },
			type: "Opaque",
			data: secretData(spec.sourceSecrets),
		},
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: buildSecretName, namespace: spec.namespace, labels },
			type: spec.registryCredentials
				? "kubernetes.io/dockerconfigjson"
				: "Opaque",
			data: {
				...secretData(spec.buildSecrets),
				...(spec.registryCredentials
					? {
							".dockerconfigjson": registryDockerConfig(
								spec.registryCredentials,
							),
						}
					: {}),
			},
		},
		{
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				backoffLimit: 0,
				activeDeadlineSeconds: spec.activeDeadlineSeconds,
				ttlSecondsAfterFinished: 900,
				template: {
					metadata: {
						labels,
						annotations: {
							"container.apparmor.security.beta.kubernetes.io/builder":
								"unconfined",
						},
					},
					spec: {
						restartPolicy: "Never",
						automountServiceAccountToken: false,
						imagePullSecrets: spec.registryCredentials
							? [{ name: buildSecretName }]
							: undefined,
						runtimeClassName: spec.runtimeClassName || undefined,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						initContainers:
							spec.sourceCommand && !spec.sourceRunsInBuilder
								? [
										{
											name: "source-fetcher",
											image: spec.builderImage,
											command: ["/bin/sh", "-lc"],
											args: [spec.sourceCommand],
											envFrom:
												Object.keys(spec.sourceSecrets).length > 0
													? [{ secretRef: { name: sourceSecretName } }]
													: undefined,
											resources: workloadResources(spec.resources),
											securityContext: {
												allowPrivilegeEscalation: false,
												capabilities: { drop: ["ALL"] },
												readOnlyRootFilesystem: true,
											},
											volumeMounts: [
												{ name: "workspace", mountPath: "/etc/dokploy" },
												{ name: "tmp", mountPath: "/tmp" },
												{ name: "source-home", mountPath: "/home/source" },
											],
											env: [{ name: "HOME", value: "/home/source" }],
										},
									]
								: undefined,
						containers: [
							{
								name: "builder",
								image: spec.builderImage,
								command: ["/bin/sh", "-lc"],
								args: [builderScript],
								env: [
									{ name: "DOCKER_BUILDKIT", value: "1" },
									{ name: "VLYV_PREINSTALLED_RAILPACK", value: "true" },
								],
								envFrom: [
									...(Object.keys(spec.buildSecrets).length > 0
										? [{ secretRef: { name: buildSecretName } }]
										: []),
									...(spec.sourceRunsInBuilder &&
									Object.keys(spec.sourceSecrets).length > 0
										? [{ secretRef: { name: sourceSecretName } }]
										: []),
								],
								resources: workloadResources(spec.resources),
								securityContext: {
									allowPrivilegeEscalation: true,
									appArmorProfile: { type: "Unconfined" },
									seccompProfile: { type: "Unconfined" },
									capabilities: {
										drop: ["ALL"],
										add: ["SETUID", "SETGID"],
									},
									readOnlyRootFilesystem: true,
								},
								terminationMessagePath: "/dev/termination-log",
								terminationMessagePolicy: "File",
								volumeMounts: [
									{ name: "workspace", mountPath: "/etc/dokploy" },
									{ name: "tmp", mountPath: "/tmp" },
									{ name: "home", mountPath: "/home/builder" },
									{ name: "artifacts", mountPath: "/artifacts" },
									{ name: "tun", mountPath: "/dev/net/tun" },
								],
							},
						],
						volumes: [
							{
								name: "workspace",
								emptyDir: {
									sizeLimit: bytesToMi(
										spec.resources.ephemeralStorageLimitBytes || 20 * 1024 ** 3,
									),
								},
							},
							{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
							{ name: "home", emptyDir: { sizeLimit: "2Gi" } },
							{ name: "source-home", emptyDir: { sizeLimit: "512Mi" } },
							{
								name: "tun",
								hostPath: { path: "/dev/net/tun", type: "CharDevice" },
							},
							{
								name: "artifacts",
								persistentVolumeClaim: {
									claimName: artifactClaimName,
								},
							},
						],
					},
				},
			},
		},
	];
};

export const buildKubernetesPublisherManifests = (
	spec: KubernetesPublisherJobSpec,
): KubernetesManifest[] => {
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(spec.publisherImage)) {
		throw new Error("Publisher image must use an immutable digest");
	}
	const buildName = k8sName(`build-${spec.deploymentId}`);
	const name = k8sName(`publish-${spec.deploymentId}`);
	const artifactClaimName = `${buildName}-artifacts`;
	const serviceAccountName = `${name}-identity`;
	const secretName = `${name}-registry`;
	const labels = labelsFor(
		spec.applicationId,
		spec.organizationId,
		"publisher",
	);
	const publisherScript = `
set -eu
export HOME=/home/publisher
mkdir -p "$HOME"
for tool in skopeo jq; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "Required publisher tool is unavailable: $tool"
		exit 1
	fi
	if ! "$tool" --version >/dev/null 2>&1; then
		echo "Publisher tool failed its integrity check: $tool"
		exit 1
	fi
done
if [ -n "\${VLYV_PLATFORM_REGISTRY_USERNAME:-}" ] && [ -n "\${VLYV_PLATFORM_REGISTRY_PASSWORD:-}" ]; then
	printf %s "$VLYV_PLATFORM_REGISTRY_PASSWORD" | skopeo login "$VLYV_PLATFORM_REGISTRY_HOST" -u "$VLYV_PLATFORM_REGISTRY_USERNAME" --password-stdin
fi
skopeo copy --digestfile /artifacts/digest docker-archive:/artifacts/image.tar "docker://$VLYV_RUNTIME_IMAGE"
digest=$(cat /artifacts/digest)
image_id=$(jq -r '.imageId' /artifacts/image.json)
image_size=$(jq -r '.imageSizeBytes' /artifacts/image.json)
repository="\${VLYV_RUNTIME_IMAGE%:*}"
printf '{"imageId":"%s","repoDigests":["%s@%s"],"imageSizeBytes":%s}' "$image_id" "$repository" "$digest" "$image_size" >/dev/termination-log
`;
	return [
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: secretName, namespace: spec.namespace, labels },
			type: spec.registryCredentials
				? "kubernetes.io/dockerconfigjson"
				: "Opaque",
			data: {
				...secretData(spec.registrySecrets),
				...(spec.registryCredentials
					? {
							".dockerconfigjson": registryDockerConfig(
								spec.registryCredentials,
							),
						}
					: {}),
			},
		},
		{
			apiVersion: "v1",
			kind: "ServiceAccount",
			metadata: {
				name: serviceAccountName,
				namespace: spec.namespace,
				labels,
				annotations: spec.serviceAccountAnnotations,
			},
			automountServiceAccountToken: false,
		},
		{
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				backoffLimit: 0,
				activeDeadlineSeconds: spec.activeDeadlineSeconds,
				ttlSecondsAfterFinished: 900,
				template: {
					metadata: {
						labels: { ...spec.podLabels, ...labels },
						annotations: spec.podAnnotations,
					},
					spec: {
						restartPolicy: "Never",
						serviceAccountName,
						automountServiceAccountToken: false,
						imagePullSecrets: spec.registryCredentials
							? [{ name: secretName }]
							: undefined,
						runtimeClassName: spec.runtimeClassName || undefined,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						containers: [
							{
								name: "publisher",
								image: spec.publisherImage,
								command: ["/bin/sh", "-lc"],
								args: [publisherScript],
								env: [
									{ name: "VLYV_RUNTIME_IMAGE", value: spec.runtimeImageRef },
								],
								envFrom: [{ secretRef: { name: secretName } }],
								resources: workloadResources(spec.resources),
								securityContext: {
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
									readOnlyRootFilesystem: true,
								},
								terminationMessagePath: "/dev/termination-log",
								terminationMessagePolicy: "File",
								volumeMounts: [
									{ name: "artifacts", mountPath: "/artifacts" },
									{ name: "home", mountPath: "/home/publisher" },
								],
							},
						],
						volumes: [
							{
								name: "artifacts",
								persistentVolumeClaim: { claimName: artifactClaimName },
							},
							{ name: "home", emptyDir: { sizeLimit: "512Mi" } },
						],
					},
				},
			},
		},
	];
};

export const buildKubernetesOutputPublisherManifests = (
	spec: KubernetesOutputPublisherJobSpec,
): KubernetesManifest[] => {
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(spec.publisherImage)) {
		throw new Error("Output publisher image must use an immutable digest");
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(spec.manifestDigest)) {
		throw new Error("Output manifest must use an immutable digest");
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,1023}$/.test(spec.objectPrefix)) {
		throw new Error("Output object prefix is invalid");
	}
	if (spec.serverSideEncryption === "aws:kms" && !spec.kmsKeyId) {
		throw new Error("Output publisher KMS encryption requires a key ID");
	}
	if (
		spec.cacheControl &&
		(spec.cacheControl.length > 1_024 || /[\r\n]/.test(spec.cacheControl))
	) {
		throw new Error("Output publisher cache control is invalid");
	}
	for (const [value, field] of [
		[spec.storageEndpoint, "storage endpoint"],
		[spec.publicBaseUrl, "public base URL"],
	] as const) {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error(`Output ${field} must use clean HTTPS`);
		}
	}
	const buildName = k8sName(`build-${spec.deploymentId}`);
	const name = k8sName(`output-${spec.deploymentId}`);
	const artifactClaimName = `${buildName}-artifacts`;
	const serviceAccountName = `${name}-identity`;
	const secretName = `${name}-storage`;
	const labels = {
		...labelsFor(spec.applicationId, spec.organizationId, "output-publisher"),
		...spec.podLabels,
	};
	const outputScript = `
set -eu
for tool in rclone jq sha256sum find awk wc; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "Required output publisher tool is unavailable: $tool"
		exit 1
	fi
done
manifest=/artifacts/output-manifest.json
static_root=/artifacts/static
if [ ! -f "$manifest" ] || [ ! -d "$static_root" ]; then
	echo "Build output artifacts are unavailable"
	exit 1
fi
if [ -n "$(find "$static_root" -type l -print -quit)" ]; then
	echo "Static output may not contain symbolic links"
	exit 1
fi
actual_digest="sha256:$(sha256sum "$manifest" | cut -d ' ' -f 1)"
if [ "$actual_digest" != "$VLYV_OUTPUT_MANIFEST_DIGEST" ]; then
	echo "Build output manifest digest mismatch"
	exit 1
fi
actual_files=$(find "$static_root" -type f -printf '.' | wc -c | tr -d ' ')
actual_bytes=$(find "$static_root" -type f -printf '%s\n' | awk '{ total += $1 } END { print total + 0 }')
expected_files=$(jq -er '.staticOutput.fileCount' "$manifest")
expected_bytes=$(jq -er '.staticOutput.totalBytes' "$manifest")
if [ "$actual_files" != "$expected_files" ] || [ "$actual_bytes" != "$expected_bytes" ]; then
	echo "Build output static inventory mismatch"
	exit 1
fi
destination="vlyv:$VLYV_STORAGE_BUCKET/$VLYV_OBJECT_PREFIX"
cleanup_failed_upload() {
	status=$?
	if [ "$status" -ne 0 ]; then rclone purge "$destination" || true; fi
	exit "$status"
}
trap cleanup_failed_upload EXIT
rclone copy "$static_root" "$destination" --immutable --checkers 8 --transfers 8 --header-upload "Cache-Control: $VLYV_STATIC_CACHE_CONTROL"
rclone copyto "$manifest" "$destination/output-manifest.json" --immutable --header-upload 'Cache-Control: no-cache'
jq -cn \
	--arg manifestDigest "$actual_digest" \
	--arg objectPrefix "$VLYV_OBJECT_PREFIX" \
	--arg publicBaseUrl "$VLYV_PUBLIC_BASE_URL" \
	--argjson fileCount "$actual_files" \
	--argjson totalBytes "$actual_bytes" \
	'{manifestDigest:$manifestDigest,objectPrefix:$objectPrefix,publicBaseUrl:$publicBaseUrl,fileCount:$fileCount,totalBytes:$totalBytes}' >/dev/termination-log
trap - EXIT
`;
	return [
		{
			apiVersion: "v1",
			kind: "ServiceAccount",
			metadata: {
				name: serviceAccountName,
				namespace: spec.namespace,
				labels,
				annotations: spec.serviceAccountAnnotations,
			},
			automountServiceAccountToken: false,
		},
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: secretName, namespace: spec.namespace, labels },
			type: spec.registryCredentials
				? "kubernetes.io/dockerconfigjson"
				: "Opaque",
			data: {
				...secretData({
					RCLONE_CONFIG_VLYV_TYPE: "s3",
					RCLONE_CONFIG_VLYV_PROVIDER:
						spec.storageProvider === "r2" ? "Cloudflare" : "Other",
					RCLONE_CONFIG_VLYV_ACCESS_KEY_ID: spec.storageAccessKeyId,
					RCLONE_CONFIG_VLYV_SECRET_ACCESS_KEY: spec.storageSecretAccessKey,
					RCLONE_CONFIG_VLYV_ENDPOINT: spec.storageEndpoint,
					RCLONE_CONFIG_VLYV_REGION: spec.storageRegion,
					RCLONE_CONFIG_VLYV_ACL: "private",
					RCLONE_CONFIG_VLYV_NO_CHECK_BUCKET: "true",
					...(spec.serverSideEncryption
						? {
								RCLONE_CONFIG_VLYV_SERVER_SIDE_ENCRYPTION:
									spec.serverSideEncryption,
							}
						: {}),
					...(spec.kmsKeyId
						? { RCLONE_CONFIG_VLYV_SSE_KMS_KEY_ID: spec.kmsKeyId }
						: {}),
				}),
				...(spec.registryCredentials
					? {
							".dockerconfigjson": registryDockerConfig(
								spec.registryCredentials,
							),
						}
					: {}),
			},
		},
		{
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				backoffLimit: 1,
				activeDeadlineSeconds: spec.activeDeadlineSeconds,
				ttlSecondsAfterFinished: 900,
				template: {
					metadata: {
						labels,
						annotations: spec.podAnnotations,
					},
					spec: {
						restartPolicy: "Never",
						serviceAccountName,
						automountServiceAccountToken: false,
						imagePullSecrets: spec.registryCredentials
							? [{ name: secretName }]
							: undefined,
						runtimeClassName: spec.runtimeClassName || undefined,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						containers: [
							{
								name: "output-publisher",
								image: spec.publisherImage,
								imagePullPolicy: "IfNotPresent",
								command: ["/bin/sh", "-lc"],
								args: [outputScript],
								envFrom: [{ secretRef: { name: secretName } }],
								env: [
									{
										name: "VLYV_OUTPUT_MANIFEST_DIGEST",
										value: spec.manifestDigest,
									},
									{
										name: "VLYV_STORAGE_BUCKET",
										value: spec.storageBucket,
									},
									{
										name: "VLYV_OBJECT_PREFIX",
										value: spec.objectPrefix,
									},
									{
										name: "VLYV_PUBLIC_BASE_URL",
										value: spec.publicBaseUrl,
									},
									{
										name: "VLYV_STATIC_CACHE_CONTROL",
										value:
											spec.cacheControl || "public, max-age=0, must-revalidate",
									},
								],
								resources: workloadResources(spec.resources),
								securityContext: {
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
									readOnlyRootFilesystem: true,
								},
								terminationMessagePath: "/dev/termination-log",
								terminationMessagePolicy: "File",
								volumeMounts: [
									{
										name: "artifacts",
										mountPath: "/artifacts",
										readOnly: true,
									},
									{ name: "tmp", mountPath: "/tmp" },
								],
							},
						],
						volumes: [
							{
								name: "artifacts",
								persistentVolumeClaim: { claimName: artifactClaimName },
							},
							{ name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
						],
					},
				},
			},
		},
	];
};

export const buildKubernetesSupplyChainManifests = (
	spec: KubernetesSupplyChainJobSpec,
): KubernetesManifest[] => {
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(spec.verifierImage)) {
		throw new Error("Verifier image must use an immutable digest");
	}
	if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(spec.imageRef)) {
		throw new Error("Supply-chain image must use an immutable digest");
	}
	const name = k8sName(`verify-${spec.deploymentId}`);
	const serviceAccountName = `${name}-identity`;
	const secretName = `${name}-registry`;
	const labels = labelsFor(
		spec.applicationId,
		spec.organizationId,
		"supply-chain",
	);
	const verifierScript = `
set -eu
export HOME=/home/verifier
mkdir -p "$HOME"
for tool in docker syft trivy cosign jq sha256sum cut; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "Required supply-chain tool is unavailable: $tool"
		exit 1
	fi
	if ! "$tool" --version >/dev/null 2>&1; then
		echo "Supply-chain tool failed its integrity check: $tool"
		exit 1
	fi
done
if [ -n "\${VLYV_PLATFORM_REGISTRY_USERNAME:-}" ] && [ -n "\${VLYV_PLATFORM_REGISTRY_PASSWORD:-}" ]; then
	printf %s "$VLYV_PLATFORM_REGISTRY_PASSWORD" | docker login "$VLYV_PLATFORM_REGISTRY_HOST" -u "$VLYV_PLATFORM_REGISTRY_USERNAME" --password-stdin
fi
syft "$VLYV_IMAGE_REF" --output cyclonedx-json=/tmp/vlyv-sbom.json
trivy_args=""
if [ "$VLYV_IGNORE_UNFIXED" = "true" ]; then trivy_args="--ignore-unfixed"; fi
trivy sbom $trivy_args --format json --output /tmp/vlyv-vulnerabilities.json /tmp/vlyv-sbom.json
critical_count=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' /tmp/vlyv-vulnerabilities.json)
high_count=$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' /tmp/vlyv-vulnerabilities.json)
if [ "$critical_count" -gt "$VLYV_MAX_CRITICAL" ]; then
	echo "Image rejected by critical vulnerability policy"
	exit 42
fi
if [ "$high_count" -gt "$VLYV_MAX_HIGH" ]; then
	echo "Image rejected by high vulnerability policy"
	exit 42
fi
cosign sign --yes --tlog-upload=false --key "$VLYV_COSIGN_KEY_REF" "$VLYV_IMAGE_REF"
cosign attest --yes --tlog-upload=false --key "$VLYV_COSIGN_KEY_REF" --type cyclonedx --predicate /tmp/vlyv-sbom.json "$VLYV_IMAGE_REF"
cosign attest --yes --tlog-upload=false --key "$VLYV_COSIGN_KEY_REF" --type vuln --predicate /tmp/vlyv-vulnerabilities.json "$VLYV_IMAGE_REF"
cosign verify --insecure-ignore-tlog --key "$VLYV_COSIGN_KEY_REF" "$VLYV_IMAGE_REF" >/tmp/vlyv-signature-verification.json
sbom_digest=$(sha256sum /tmp/vlyv-sbom.json | cut -d ' ' -f 1)
vulnerability_digest=$(sha256sum /tmp/vlyv-vulnerabilities.json | cut -d ' ' -f 1)
printf '{"sbomDigest":"sha256:%s","vulnerabilityReportDigest":"sha256:%s","criticalVulnerabilities":%s,"highVulnerabilities":%s,"signed":true,"signatureVerified":true}' "$sbom_digest" "$vulnerability_digest" "$critical_count" "$high_count" >/dev/termination-log
`;
	return [
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: secretName, namespace: spec.namespace, labels },
			type: spec.registryCredentials
				? "kubernetes.io/dockerconfigjson"
				: "Opaque",
			data: {
				...secretData({
					...spec.registrySecrets,
					...spec.signingSecrets,
					VLYV_COSIGN_KEY_REF: spec.signingKeyRef,
				}),
				...(spec.registryCredentials
					? {
							".dockerconfigjson": registryDockerConfig(
								spec.registryCredentials,
							),
						}
					: {}),
			},
		},
		{
			apiVersion: "v1",
			kind: "ServiceAccount",
			metadata: {
				name: serviceAccountName,
				namespace: spec.namespace,
				labels,
				annotations: spec.serviceAccountAnnotations,
			},
			automountServiceAccountToken: false,
		},
		{
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				backoffLimit: 0,
				activeDeadlineSeconds: spec.activeDeadlineSeconds,
				ttlSecondsAfterFinished: 900,
				template: {
					metadata: {
						labels: { ...spec.podLabels, ...labels },
						annotations: spec.podAnnotations,
					},
					spec: {
						restartPolicy: "Never",
						serviceAccountName,
						automountServiceAccountToken: false,
						imagePullSecrets: spec.registryCredentials
							? [{ name: secretName }]
							: undefined,
						runtimeClassName: spec.runtimeClassName || undefined,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						containers: [
							{
								name: "verifier",
								image: spec.verifierImage,
								command: ["/bin/sh", "-lc"],
								args: [verifierScript],
								env: [
									{ name: "VLYV_IMAGE_REF", value: spec.imageRef },
									{
										name: "VLYV_MAX_CRITICAL",
										value: String(spec.maxCriticalVulnerabilities),
									},
									{
										name: "VLYV_MAX_HIGH",
										value: String(spec.maxHighVulnerabilities),
									},
									{
										name: "VLYV_IGNORE_UNFIXED",
										value: String(spec.ignoreUnfixed),
									},
								],
								envFrom: [{ secretRef: { name: secretName } }],
								resources: workloadResources(spec.resources),
								securityContext: {
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
									readOnlyRootFilesystem: true,
								},
								terminationMessagePath: "/dev/termination-log",
								terminationMessagePolicy: "File",
								volumeMounts: [
									{ name: "tmp", mountPath: "/tmp" },
									{ name: "home", mountPath: "/home/verifier" },
								],
							},
						],
						volumes: [
							{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
							{ name: "home", emptyDir: { sizeLimit: "512Mi" } },
						],
					},
				},
			},
		},
	];
};

export const kubernetesManifestName = k8sName;
