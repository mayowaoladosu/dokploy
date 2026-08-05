import { createHash } from "node:crypto";
import type { KubernetesObject } from "@kubernetes/client-node";
import { quote } from "shell-quote";

export type KubernetesManifest = KubernetesObject & Record<string, unknown>;

export type KubernetesDomainRoute = {
	host: string;
	path?: string | null;
};

export type KubernetesPort = {
	targetPort: number;
	protocol?: "tcp" | "udp";
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
	gateway?: {
		namespace: string;
		name: string;
		sectionName?: string;
		className?: string;
		certIssuerName?: string;
	};
	domains: KubernetesDomainRoute[];
	allowedEgressCidrs?: string[];
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
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: KubernetesPlacementSpec["tolerations"];
	activeDeadlineSeconds: number;
	resources: KubernetesResourceSpec;
	artifactStorageClassName: string;
	sourceSecrets: Record<string, string>;
	buildSecrets: Record<string, string>;
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
	return {
		apiVersion: "gateway.networking.k8s.io/v1",
		kind: "HTTPRoute",
		metadata: {
			name,
			namespace,
			labels: labelsFor(applicationId, organizationId, "runtime"),
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
	if (!gateway.className || !gateway.certIssuerName) {
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
	const name = kubernetesApplicationResourceName(spec.applicationId);
	const labels = labelsFor(spec.applicationId, spec.organizationId, "runtime");
	const secretName = `${name}-env`;
	const ports = spec.ports.length > 0 ? spec.ports : [{ targetPort: 3000 }];
	const maxReplicas = Math.max(spec.maxReplicas, spec.replicas);
	const aggregateMultiplier = Math.max(maxReplicas, 1);
	const manifests: KubernetesManifest[] = [
		{
			apiVersion: "v1",
			kind: "Namespace",
			metadata: {
				name: spec.namespace,
				labels: {
					...labels,
					"app.kubernetes.io/managed-by": "vlyv",
					"pod-security.kubernetes.io/enforce": "restricted",
					"pod-security.kubernetes.io/audit": "restricted",
					"pod-security.kubernetes.io/warn": "restricted",
				},
			},
		},
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
			data: secretData(environmentToStringData(spec.environment)),
		},
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
													"kubernetes.io/metadata.name": spec.gateway.namespace,
												},
											},
										},
									],
								},
							]
						: []),
				],
			},
		},
		...buildEgressPolicyManifests(spec.namespace, spec.allowedEgressCidrs),
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name, namespace: spec.namespace, labels },
			spec: {
				replicas: Math.max(spec.replicas, 1),
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
						runtimeClassName: spec.runtimeClassName || undefined,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						imagePullSecrets: spec.registrySecretName
							? [{ name: spec.registrySecretName }]
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
								securityContext: {
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
									readOnlyRootFilesystem: true,
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
				minAvailable: 1,
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
		manifests.push(
			...buildKubernetesRoutingManifests({
				applicationId: spec.applicationId,
				organizationId: spec.organizationId,
				appName: spec.appName,
				namespace: spec.namespace,
				gateway: spec.gateway,
				domains: spec.domains,
				port: ports[0]?.targetPort ?? 3000,
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
	const builderScript = `
set -e
export HOME=/home/builder
export XDG_RUNTIME_DIR=/tmp/docker-runtime
export DOCKER_HOST=unix:///tmp/docker-runtime/docker.sock
mkdir -p "$HOME" "$XDG_RUNTIME_DIR"
mkdir -p /etc/dokploy/ssh /etc/dokploy/applications /etc/dokploy/patch-repos
dockerd-rootless.sh --host="$DOCKER_HOST" --storage-driver=fuse-overlayfs > /tmp/dockerd.log 2>&1 &
for attempt in $(seq 1 60); do
	if docker info >/dev/null 2>&1; then break; fi
	if [ "$attempt" -eq 60 ]; then cat /tmp/dockerd.log; exit 1; fi
	sleep 1
done
${spec.sourceRunsInBuilder ? spec.sourceCommand : ""}
${spec.buildCommand}
image_id=$(docker image inspect --format '{{.Id}}' ${localImage})
image_size=$(docker image inspect --format '{{.Size}}' ${localImage})
docker save --output /artifacts/image.tar ${localImage}
printf '{"imageId":"%s","imageSizeBytes":%s}' "$image_id" "$image_size" >/artifacts/image.json
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
					"pod-security.kubernetes.io/enforce": "restricted",
					"pod-security.kubernetes.io/audit": "restricted",
					"pod-security.kubernetes.io/warn": "restricted",
				},
			},
		},
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
					"count/jobs.batch": "2",
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
			type: "Opaque",
			data: secretData(spec.buildSecrets),
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
					metadata: { labels },
					spec: {
						restartPolicy: "Never",
						automountServiceAccountToken: false,
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
									allowPrivilegeEscalation: false,
									capabilities: { drop: ["ALL"] },
									readOnlyRootFilesystem: true,
								},
								terminationMessagePath: "/dev/termination-log",
								terminationMessagePolicy: "File",
								volumeMounts: [
									{ name: "workspace", mountPath: "/etc/dokploy" },
									{ name: "tmp", mountPath: "/tmp" },
									{ name: "home", mountPath: "/home/builder" },
									{ name: "artifacts", mountPath: "/artifacts" },
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
			type: "Opaque",
			data: secretData(spec.registrySecrets),
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
			type: "Opaque",
			data: secretData({
				...spec.registrySecrets,
				VLYV_COSIGN_KEY_REF: spec.signingKeyRef,
			}),
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
