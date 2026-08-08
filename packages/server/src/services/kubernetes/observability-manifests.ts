import { createHash } from "node:crypto";
import { buildKubernetesControlPlaneRoleBinding } from "./control-plane-rbac";
import type { KubernetesManifest } from "./manifests";

export type ObservabilityCollectorBackend = {
	endpoint: string;
	authToken?: string | null;
	tenantHeader?: string;
	tenantId?: string;
};

export type KubernetesObservabilityCollectorSpec = {
	namespace?: string;
	image: string;
	otlp?: {
		endpoint: string;
		headers?: Record<string, string>;
	} | null;
	metrics?: ObservabilityCollectorBackend | null;
	logs?: ObservabilityCollectorBackend | null;
	traces?: ObservabilityCollectorBackend | null;
	nodeSelector?: Record<string, string>;
	tolerations?: Array<{
		key: string;
		value?: string;
		effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
	}>;
};

const immutableImage = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const cleanEndpoint = (value: string) => {
	const url = new URL(value);
	if (
		!(["https:", "http:"] as const).includes(
			url.protocol as "https:" | "http:",
		) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Collector backend endpoint is invalid");
	}
	return url.toString().replace(/\/$/, "");
};

const encodedSecret = (values: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(values).map(([key, value]) => [
			key,
			Buffer.from(value, "utf8").toString("base64"),
		]),
	);

export const buildKubernetesObservabilityCollectorManifests = (
	spec: KubernetesObservabilityCollectorSpec,
): KubernetesManifest[] => {
	if (!immutableImage.test(spec.image)) {
		throw new Error(
			"Observability collector image must use an immutable digest",
		);
	}
	if (!spec.otlp && !spec.metrics && !spec.logs && !spec.traces) {
		throw new Error("Observability collector requires at least one backend");
	}
	const namespace = spec.namespace || "vlyv-observability";
	const labels = {
		"app.kubernetes.io/name": "vlyv-otel-collector",
		"app.kubernetes.io/managed-by": "vlyv",
		"app.kubernetes.io/component": "observability",
	};
	const exporters: Record<string, unknown> = {
		prometheus: { endpoint: "0.0.0.0:8889", enable_open_metrics: true },
	};
	const secretValues: Record<string, string> = {};
	const pipelines: Record<string, unknown> = {};
	const tenantProcessors = [
		"memory_limiter",
		"k8s_attributes",
		"filter/tenant",
		"transform/tenant",
		"resource/vlyv",
		"batch",
	];
	const tenantTransformStatements = [
		'set(resource.attributes["vlyv.organization.id"], resource.attributes["vlyv.enforced.organization.id"])',
		'set(resource.attributes["vlyv.application.id"], resource.attributes["vlyv.enforced.application.id"])',
		'delete_key(resource.attributes, "vlyv.enforced.organization.id")',
		'delete_key(resource.attributes, "vlyv.enforced.application.id")',
	];
	const backendPorts = new Set<number>([443]);
	const addHeaders = (name: string, backend: ObservabilityCollectorBackend) => {
		const headers: Record<string, string> = {};
		if (backend.authToken) {
			const environmentName = `${name.toUpperCase()}_AUTH_TOKEN`;
			secretValues[environmentName] = backend.authToken;
			headers.Authorization = `Bearer \${env:${environmentName}}`;
		}
		if (backend.tenantHeader && backend.tenantId) {
			headers[backend.tenantHeader] = backend.tenantId;
		}
		return headers;
	};
	const addRawHeaders = (name: string, values: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(values).map(([header, value], index) => {
				const environmentName = `${name.toUpperCase()}_HEADER_${index}`;
				secretValues[environmentName] = value;
				return [header, `\${env:${environmentName}}`];
			}),
		);
	if (spec.otlp) {
		const endpoint = cleanEndpoint(spec.otlp.endpoint);
		const url = new URL(endpoint);
		backendPorts.add(
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		);
		exporters["otlp_http/platform"] = {
			endpoint,
			headers: addRawHeaders("otlp", spec.otlp.headers ?? {}),
		};
		pipelines.metrics = {
			receivers: ["otlp"],
			processors: tenantProcessors,
			exporters: ["prometheus", "otlp_http/platform"],
		};
		pipelines.logs = {
			receivers: ["otlp"],
			processors: tenantProcessors,
			exporters: ["otlp_http/platform"],
		};
		pipelines.traces = {
			receivers: ["otlp"],
			processors: tenantProcessors,
			exporters: ["otlp_http/platform"],
		};
	}
	if (spec.metrics && !spec.otlp) {
		const endpoint = cleanEndpoint(spec.metrics.endpoint);
		const url = new URL(endpoint);
		backendPorts.add(
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		);
		exporters["prometheus_remote_write/metrics"] = {
			endpoint: `${endpoint}/api/v1/write`,
			headers: addHeaders("metrics", spec.metrics),
			resource_to_telemetry_conversion: { enabled: true },
		};
		pipelines.metrics = {
			receivers: ["otlp"],
			processors: tenantProcessors,
			exporters: ["prometheus", "prometheus_remote_write/metrics"],
		};
	}
	if (spec.logs && !spec.otlp) {
		const endpoint = cleanEndpoint(spec.logs.endpoint);
		const url = new URL(endpoint);
		backendPorts.add(
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		);
		exporters["otlp_http/logs"] = {
			endpoint,
			headers: addHeaders("logs", spec.logs),
		};
		pipelines.logs = {
			receivers: ["otlp"],
			processors: tenantProcessors,
			exporters: ["otlp_http/logs"],
		};
	}
	if (spec.traces && !spec.otlp) {
		const endpoint = cleanEndpoint(spec.traces.endpoint);
		const url = new URL(endpoint);
		backendPorts.add(
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
		);
		exporters["otlp_http/traces"] = {
			endpoint,
			headers: addHeaders("traces", spec.traces),
		};
		pipelines.traces = {
			receivers: ["otlp"],
			processors: tenantProcessors,
			exporters: ["otlp_http/traces"],
		};
	}
	const collectorConfig = {
		receivers: {
			otlp: {
				protocols: {
					grpc: { endpoint: "0.0.0.0:4317" },
					http: { endpoint: "0.0.0.0:4318" },
				},
			},
		},
		processors: {
			memory_limiter: {
				check_interval: "1s",
				limit_mib: 384,
				spike_limit_mib: 96,
			},
			batch: { timeout: "5s", send_batch_size: 1024 },
			k8s_attributes: {
				auth_type: "serviceAccount",
				passthrough: false,
				pod_association: [
					{ sources: [{ from: "connection" }] },
					{
						sources: [
							{
								from: "resource_attribute",
								name: "k8s.pod.ip",
							},
						],
					},
				],
				extract: {
					metadata: ["k8s.namespace.name", "k8s.pod.name", "k8s.pod.uid"],
					labels: [
						{
							tag_name: "vlyv.enforced.organization.id",
							key: "vlyv.dev/observability-tenant",
							from: "namespace",
						},
						{
							tag_name: "vlyv.enforced.application.id",
							key: "vlyv.dev/observability-app",
							from: "pod",
						},
					],
				},
			},
			"filter/tenant": {
				error_mode: "ignore",
				traces: {
					span: ['resource.attributes["vlyv.enforced.organization.id"] == nil'],
				},
				metrics: {
					datapoint: [
						'resource.attributes["vlyv.enforced.organization.id"] == nil',
					],
				},
				logs: {
					log_record: [
						'resource.attributes["vlyv.enforced.organization.id"] == nil',
					],
				},
			},
			"transform/tenant": {
				error_mode: "ignore",
				trace_statements: [
					{
						context: "resource",
						statements: tenantTransformStatements,
					},
				],
				metric_statements: [
					{
						context: "resource",
						statements: tenantTransformStatements,
					},
				],
				log_statements: [
					{
						context: "resource",
						statements: tenantTransformStatements,
					},
				],
			},
			"resource/vlyv": {
				attributes: [
					{ key: "vlyv.collector", value: "managed", action: "upsert" },
				],
			},
		},
		exporters,
		extensions: { health_check: { endpoint: "0.0.0.0:13133" } },
		service: {
			extensions: ["health_check"],
			pipelines,
			telemetry: {
				metrics: {
					level: "normal",
					readers: [
						{
							pull: {
								exporter: {
									prometheus: { host: "0.0.0.0", port: 8888 },
								},
							},
						},
					],
				},
			},
		},
	};
	const logExporter = spec.otlp
		? exporters["otlp_http/platform"]
		: exporters["otlp_http/logs"];
	const logAgentConfig =
		spec.logs || spec.otlp
			? {
					receivers: {
						file_log: {
							include: ["/var/log/pods/*/*/*.log"],
							start_at: "end",
							include_file_path: true,
							operators: [
								{ type: "container", id: "container-parser" },
								{
									type: "regex_parser",
									id: "extract-kubernetes-path",
									parse_from: 'attributes["log.file.path"]',
									regex:
										"^/var/log/pods/(?P<namespace>[^_]+)_(?P<pod_name>[^_]+)_(?P<uid>[^/]+)/(?P<container_name>[^/]+)/(?P<restart_count>\\d+)\\.log$",
								},
								{
									type: "move",
									from: "attributes.namespace",
									to: 'resource["k8s.namespace.name"]',
								},
								{
									type: "move",
									from: "attributes.pod_name",
									to: 'resource["k8s.pod.name"]',
								},
								{
									type: "move",
									from: "attributes.uid",
									to: 'resource["k8s.pod.uid"]',
								},
								{
									type: "move",
									from: "attributes.container_name",
									to: 'resource["k8s.container.name"]',
								},
							],
						},
					},
					processors: {
						k8s_attributes: {
							auth_type: "serviceAccount",
							passthrough: false,
							pod_association: [
								{
									sources: [
										{
											from: "resource_attribute",
											name: "k8s.pod.uid",
										},
									],
								},
							],
							extract: {
								metadata: [
									"k8s.namespace.name",
									"k8s.pod.name",
									"k8s.pod.uid",
									"k8s.container.name",
								],
								labels: [
									{
										tag_name: "vlyv.organization.id",
										key: "vlyv.dev/observability-tenant",
										from: "namespace",
									},
									{
										tag_name: "vlyv.application.id",
										key: "vlyv.dev/observability-app",
										from: "pod",
									},
								],
							},
						},
						"filter/tenant": {
							error_mode: "ignore",
							logs: {
								log_record: [
									'resource.attributes["vlyv.organization.id"] == nil',
								],
							},
						},
						memory_limiter: {
							check_interval: "1s",
							limit_mib: 192,
							spike_limit_mib: 48,
						},
						batch: { timeout: "5s", send_batch_size: 1024 },
						"resource/vlyv": {
							attributes: [
								{
									key: "service.name",
									value: "vlyv-runtime",
									action: "upsert",
								},
								{ key: "vlyv.collector", value: "log-agent", action: "upsert" },
							],
						},
					},
					exporters: { "otlp_http/logs": logExporter },
					service: {
						pipelines: {
							logs: {
								receivers: ["file_log"],
								processors: [
									"memory_limiter",
									"k8s_attributes",
									"filter/tenant",
									"resource/vlyv",
									"batch",
								],
								exporters: ["otlp_http/logs"],
							},
						},
					},
				}
			: null;
	const configurationHash = createHash("sha256")
		.update(JSON.stringify({ collectorConfig, logAgentConfig, secretValues }))
		.digest("hex");
	return [
		{
			apiVersion: "v1",
			kind: "Namespace",
			metadata: {
				name: namespace,
				labels: {
					...labels,
					"vlyv.dev/managed": "true",
					"pod-security.kubernetes.io/enforce": logAgentConfig
						? "privileged"
						: "restricted",
					"pod-security.kubernetes.io/audit": "restricted",
					"pod-security.kubernetes.io/warn": "restricted",
				},
			},
		},
		buildKubernetesControlPlaneRoleBinding(namespace),
		{
			apiVersion: "v1",
			kind: "ServiceAccount",
			metadata: { name: "vlyv-otel-collector", namespace, labels },
			automountServiceAccountToken: true,
		},
		{
			apiVersion: "rbac.authorization.k8s.io/v1",
			kind: "ClusterRole",
			metadata: { name: "vlyv-otel-collector", labels },
			rules: [
				{
					apiGroups: [""],
					resources: ["pods", "namespaces"],
					verbs: ["get", "list", "watch"],
				},
			],
		},
		{
			apiVersion: "rbac.authorization.k8s.io/v1",
			kind: "ClusterRoleBinding",
			metadata: { name: "vlyv-otel-collector", labels },
			roleRef: {
				apiGroup: "rbac.authorization.k8s.io",
				kind: "ClusterRole",
				name: "vlyv-otel-collector",
			},
			subjects: [
				{
					kind: "ServiceAccount",
					name: "vlyv-otel-collector",
					namespace,
				},
			],
		},
		{
			apiVersion: "v1",
			kind: "ConfigMap",
			metadata: { name: "vlyv-otel-collector", namespace, labels },
			data: {
				"collector.json": JSON.stringify(collectorConfig),
				...(logAgentConfig
					? { "log-agent.json": JSON.stringify(logAgentConfig) }
					: {}),
			},
		},
		...(Object.keys(secretValues).length > 0
			? [
					{
						apiVersion: "v1",
						kind: "Secret",
						metadata: {
							name: "vlyv-otel-collector-backends",
							namespace,
							labels,
						},
						type: "Opaque",
						data: encodedSecret(secretValues),
					},
				]
			: []),
		...(logAgentConfig
			? [
					{
						apiVersion: "v1",
						kind: "ServiceAccount",
						metadata: {
							name: "vlyv-otel-log-agent",
							namespace,
							labels: {
								...labels,
								"app.kubernetes.io/name": "vlyv-otel-log-agent",
							},
						},
					},
					{
						apiVersion: "rbac.authorization.k8s.io/v1",
						kind: "ClusterRole",
						metadata: { name: "vlyv-otel-log-agent", labels },
						rules: [
							{
								apiGroups: [""],
								resources: ["pods", "namespaces"],
								verbs: ["get", "list", "watch"],
							},
						],
					},
					{
						apiVersion: "rbac.authorization.k8s.io/v1",
						kind: "ClusterRoleBinding",
						metadata: { name: "vlyv-otel-log-agent", labels },
						roleRef: {
							apiGroup: "rbac.authorization.k8s.io",
							kind: "ClusterRole",
							name: "vlyv-otel-log-agent",
						},
						subjects: [
							{
								kind: "ServiceAccount",
								name: "vlyv-otel-log-agent",
								namespace,
							},
						],
					},
					{
						apiVersion: "apps/v1",
						kind: "DaemonSet",
						metadata: {
							name: "vlyv-otel-log-agent",
							namespace,
							labels: {
								...labels,
								"app.kubernetes.io/name": "vlyv-otel-log-agent",
							},
						},
						spec: {
							selector: {
								matchLabels: {
									"app.kubernetes.io/name": "vlyv-otel-log-agent",
								},
							},
							template: {
								metadata: {
									annotations: {
										"vlyv.dev/observability-config-sha256": configurationHash,
									},
									labels: {
										...labels,
										"app.kubernetes.io/name": "vlyv-otel-log-agent",
									},
								},
								spec: {
									serviceAccountName: "vlyv-otel-log-agent",
									securityContext: {
										seccompProfile: { type: "RuntimeDefault" },
									},
									tolerations: [
										{ operator: "Exists", effect: "NoSchedule" },
										{ operator: "Exists", effect: "NoExecute" },
									],
									containers: [
										{
											name: "log-agent",
											image: spec.image,
											args: ["--config=/etc/otel/log-agent.json"],
											envFrom: Object.keys(secretValues).length
												? [
														{
															secretRef: {
																name: "vlyv-otel-collector-backends",
															},
														},
													]
												: undefined,
											resources: {
												requests: { cpu: "50m", memory: "64Mi" },
												limits: { cpu: "500m", memory: "256Mi" },
											},
											securityContext: {
												runAsUser: 0,
												allowPrivilegeEscalation: false,
												readOnlyRootFilesystem: true,
												capabilities: { drop: ["ALL"] },
											},
											volumeMounts: [
												{
													name: "config",
													mountPath: "/etc/otel",
													readOnly: true,
												},
												{
													name: "pod-logs",
													mountPath: "/var/log/pods",
													readOnly: true,
												},
												{ name: "tmp", mountPath: "/tmp" },
											],
										},
									],
									volumes: [
										{
											name: "config",
											configMap: { name: "vlyv-otel-collector" },
										},
										{
											name: "pod-logs",
											hostPath: { path: "/var/log/pods", type: "Directory" },
										},
										{ name: "tmp", emptyDir: { sizeLimit: "64Mi" } },
									],
								},
							},
						},
					},
					{
						apiVersion: "networking.k8s.io/v1",
						kind: "NetworkPolicy",
						metadata: {
							name: "vlyv-otel-log-agent",
							namespace,
							labels,
						},
						spec: {
							podSelector: {
								matchLabels: {
									"app.kubernetes.io/name": "vlyv-otel-log-agent",
								},
							},
							policyTypes: ["Ingress", "Egress"],
							ingress: [],
							egress: [
								{
									ports: [
										{ protocol: "UDP", port: 53 },
										{ protocol: "TCP", port: 53 },
									],
								},
								{
									ports: Array.from(backendPorts).map((port) => ({
										protocol: "TCP",
										port,
									})),
								},
							],
						},
					},
				]
			: []),
		{
			apiVersion: "apps/v1",
			kind: "Deployment",
			metadata: { name: "vlyv-otel-collector", namespace, labels },
			spec: {
				replicas: 2,
				selector: { matchLabels: labels },
				template: {
					metadata: {
						labels,
						annotations: {
							"vlyv.dev/observability-config-sha256": configurationHash,
							"prometheus.io/scrape": "true",
							"prometheus.io/port": "8888",
							"prometheus.io/path": "/metrics",
						},
					},
					spec: {
						serviceAccountName: "vlyv-otel-collector",
						automountServiceAccountToken: true,
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							runAsUser: 10001,
							runAsGroup: 10001,
							fsGroup: 10001,
							seccompProfile: { type: "RuntimeDefault" },
						},
						containers: [
							{
								name: "collector",
								image: spec.image,
								args: ["--config=/etc/otel/collector.json"],
								ports: [
									{ name: "otlp-grpc", containerPort: 4317 },
									{ name: "otlp-http", containerPort: 4318 },
									{ name: "health", containerPort: 13133 },
									{ name: "metrics", containerPort: 8888 },
									{ name: "prom-export", containerPort: 8889 },
								],
								...(Object.keys(secretValues).length > 0
									? {
											envFrom: [
												{
													secretRef: {
														name: "vlyv-otel-collector-backends",
													},
												},
											],
										}
									: {}),
								readinessProbe: {
									httpGet: { path: "/", port: "health" },
									periodSeconds: 10,
								},
								livenessProbe: {
									httpGet: { path: "/", port: "health" },
									periodSeconds: 20,
								},
								resources: {
									requests: { cpu: "100m", memory: "128Mi" },
									limits: { cpu: "1", memory: "512Mi" },
								},
								securityContext: {
									allowPrivilegeEscalation: false,
									readOnlyRootFilesystem: true,
									capabilities: { drop: ["ALL"] },
								},
								volumeMounts: [
									{
										name: "config",
										mountPath: "/etc/otel",
										readOnly: true,
									},
									{ name: "tmp", mountPath: "/tmp" },
								],
							},
						],
						volumes: [
							{
								name: "config",
								configMap: { name: "vlyv-otel-collector" },
							},
							{ name: "tmp", emptyDir: { sizeLimit: "128Mi" } },
						],
					},
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "Service",
			metadata: { name: "vlyv-otel-collector", namespace, labels },
			spec: {
				selector: labels,
				ports: [
					{ name: "otlp-grpc", port: 4317, targetPort: "otlp-grpc" },
					{ name: "otlp-http", port: 4318, targetPort: "otlp-http" },
					{ name: "prometheus", port: 8889, targetPort: "prom-export" },
				],
			},
		},
		{
			apiVersion: "policy/v1",
			kind: "PodDisruptionBudget",
			metadata: { name: "vlyv-otel-collector", namespace, labels },
			spec: { minAvailable: 1, selector: { matchLabels: labels } },
		},
		{
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: { name: "vlyv-otel-collector", namespace, labels },
			spec: {
				podSelector: { matchLabels: labels },
				policyTypes: ["Ingress", "Egress"],
				ingress: [
					{
						from: [
							{
								namespaceSelector: {
									matchLabels: { "vlyv.dev/managed": "true" },
								},
								podSelector: {
									matchLabels: {
										"app.kubernetes.io/component": "runtime",
									},
								},
							},
						],
						ports: [
							{ protocol: "TCP", port: 4317 },
							{ protocol: "TCP", port: 4318 },
						],
					},
				],
				egress: [
					{
						ports: Array.from(backendPorts).map((port) => ({
							protocol: "TCP",
							port,
						})),
					},
					{
						ports: [
							{ protocol: "UDP", port: 53 },
							{ protocol: "TCP", port: 53 },
						],
					},
				],
			},
		},
	];
};
