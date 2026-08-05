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
	command: string;
	localImageRef: string;
	runtimeImageRef: string;
	runtimeClassName?: string | null;
	nodeSelector?: Record<string, string>;
	tolerations?: KubernetesPlacementSpec["tolerations"];
	activeDeadlineSeconds: number;
	resources: KubernetesResourceSpec;
	secrets: Record<string, string>;
	allowedEgressCidrs?: string[];
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
	const secretName = `${name}-credentials`;
	const localImage = quote([spec.localImageRef]);
	const artifactScript = `
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
${spec.command}
image_id=$(docker image inspect --format '{{.Id}}' ${localImage})
repo_digests=$(docker image inspect --format '{{json .RepoDigests}}' ${localImage})
image_size=$(docker image inspect --format '{{.Size}}' ${localImage})
artifact_file=$(mktemp /tmp/vlyv-artifact.XXXXXX)
printf '{"imageId":"%s","repoDigests":%s,"imageSizeBytes":%s}' "$image_id" "$repo_digests" "$image_size" > "$artifact_file"
cat "$artifact_file" > /dev/termination-log
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
					"count/jobs.batch": "1",
				},
			},
		},
		{
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: { name: "default-deny-ingress", namespace: spec.namespace },
			spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] },
		},
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: { name: secretName, namespace: spec.namespace, labels },
			type: "Opaque",
			data: secretData(spec.secrets),
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
						containers: [
							{
								name: "builder",
								image: spec.builderImage,
								command: ["/bin/sh", "-lc"],
								args: [artifactScript],
								env: [
									{ name: "DOCKER_BUILDKIT", value: "1" },
									{ name: "VLYV_PREINSTALLED_RAILPACK", value: "true" },
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
									{ name: "workspace", mountPath: "/etc/dokploy" },
									{ name: "tmp", mountPath: "/tmp" },
									{ name: "home", mountPath: "/home/builder" },
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
						],
					},
				},
			},
		},
		...buildEgressPolicyManifests(spec.namespace, spec.allowedEgressCidrs),
	];
};

export const kubernetesManifestName = k8sName;
