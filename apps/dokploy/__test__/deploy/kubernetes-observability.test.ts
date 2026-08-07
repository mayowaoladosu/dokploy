import { buildKubernetesObservabilityCollectorManifests } from "@dokploy/server/services/kubernetes/observability-manifests";
import { controlPlaneObservabilityManifests } from "@dokploy/server/services/platform-observability-reconciler";
import { describe, expect, it } from "vitest";

const findManifest = (manifests: Array<Record<string, any>>, kind: string) => {
	const manifest = manifests.find((entry) => entry.kind === kind);
	if (!manifest) throw new Error(`${kind} manifest was not generated`);
	return manifest;
};

describe("Kubernetes observability collector", () => {
	const manifests = buildKubernetesObservabilityCollectorManifests({
		image: `otel/opentelemetry-collector-contrib@sha256:${"a".repeat(64)}`,
		metrics: {
			endpoint: "https://mimir.vlyv.dev",
			authToken: "metrics-secret",
			tenantHeader: "X-Scope-OrgID",
			tenantId: "vlyv-platform",
		},
		logs: {
			endpoint: "https://loki.vlyv.dev/otlp",
			authToken: "logs-secret",
			tenantHeader: "X-Scope-OrgID",
			tenantId: "vlyv-platform",
		},
		traces: {
			endpoint: "https://tempo.vlyv.dev",
			authToken: "traces-secret",
			tenantHeader: "X-Scope-OrgID",
			tenantId: "vlyv-platform",
		},
		nodeSelector: { "vlyv.dev/pool": "system" },
	});

	it("creates a restricted redundant collector with OTLP and Prometheus ports", () => {
		const deployment = findManifest(manifests, "Deployment");
		const container = deployment.spec.template.spec.containers[0];
		expect(deployment.spec.replicas).toBe(2);
		expect(deployment.spec.template.spec).toMatchObject({
			automountServiceAccountToken: true,
			nodeSelector: { "vlyv.dev/pool": "system" },
			securityContext: { runAsNonRoot: true },
		});
		expect(container.image).toContain("@sha256:");
		expect(container.securityContext).toMatchObject({
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
		});
		expect(container.ports.map((port: any) => port.containerPort)).toEqual(
			expect.arrayContaining([4317, 4318, 8888, 8889]),
		);
		expect(
			findManifest(manifests, "PodDisruptionBudget").spec.minAvailable,
		).toBe(1);
	});

	it("keeps cluster RBAC and the host log agent admin-managed", () => {
		const reconciled = controlPlaneObservabilityManifests(manifests);
		expect(reconciled.some((manifest) => manifest.kind === "ClusterRole")).toBe(
			false,
		);
		expect(
			reconciled.some((manifest) => manifest.kind === "ClusterRoleBinding"),
		).toBe(false);
		expect(reconciled.some((manifest) => manifest.kind === "DaemonSet")).toBe(
			false,
		);
		expect(reconciled.some((manifest) => manifest.kind === "Deployment")).toBe(
			true,
		);
	});

	it("overwrites client tenant claims from Kubernetes metadata", () => {
		const config = findManifest(manifests, "ConfigMap");
		const collector = JSON.parse(config.data["collector.json"]);
		const role = (manifests as any[]).find(
			(manifest) =>
				manifest.kind === "ClusterRole" &&
				manifest.metadata?.name === "vlyv-otel-collector",
		);

		expect(collector.service.pipelines.traces.processors).toEqual([
			"memory_limiter",
			"k8sattributes",
			"filter/tenant",
			"transform/tenant",
			"resource/vlyv",
			"batch",
		]);
		expect(collector.processors["filter/tenant"].traces.span).toContain(
			'resource.attributes["vlyv.enforced.organization.id"] == nil',
		);
		expect(
			collector.processors["transform/tenant"].trace_statements[0].statements,
		).toContain(
			'set(attributes["vlyv.organization.id"], attributes["vlyv.enforced.organization.id"])',
		);
		expect(role.rules).toEqual([
			expect.objectContaining({
				resources: ["pods", "namespaces"],
				verbs: ["get", "list", "watch"],
			}),
		]);
	});

	it("keeps backend credentials only in a Kubernetes Secret", () => {
		const secret = findManifest(manifests, "Secret");
		const deployment = findManifest(manifests, "Deployment");
		const config = findManifest(manifests, "ConfigMap");
		expect(secret.data).toHaveProperty("METRICS_AUTH_TOKEN");
		expect(secret.data).toHaveProperty("LOGS_AUTH_TOKEN");
		expect(secret.data).toHaveProperty("TRACES_AUTH_TOKEN");
		expect(JSON.stringify(deployment)).not.toContain("metrics-secret");
		expect(JSON.stringify(config)).not.toContain("metrics-secret");
		const collector = JSON.parse(config.data["collector.json"]);
		expect(
			collector.exporters["prometheusremotewrite/metrics"].headers[
				"X-Scope-OrgID"
			],
		).toBe("vlyv-platform");
		expect(
			collector.exporters["prometheusremotewrite/metrics"]
				.resource_to_telemetry_conversion,
		).toEqual({ enabled: true });
	});

	it("collects only tenant-labeled pod logs with read-only host access", () => {
		const daemonSet = findManifest(manifests, "DaemonSet");
		const config = findManifest(manifests, "ConfigMap");
		const clusterRole = findManifest(manifests, "ClusterRole");
		const namespace = findManifest(manifests, "Namespace");
		const agentConfig = JSON.parse(config.data["log-agent.json"]);

		expect(
			namespace.metadata.labels["pod-security.kubernetes.io/enforce"],
		).toBe("privileged");
		expect(daemonSet.spec.template.spec.volumes).toContainEqual(
			expect.objectContaining({
				name: "pod-logs",
				hostPath: { path: "/var/log/pods", type: "Directory" },
			}),
		);
		expect(
			daemonSet.spec.template.spec.containers[0].volumeMounts,
		).toContainEqual(
			expect.objectContaining({ name: "pod-logs", readOnly: true }),
		);
		expect(clusterRole.rules).toEqual([
			expect.objectContaining({
				resources: ["pods", "namespaces"],
				verbs: ["get", "list", "watch"],
			}),
		]);
		expect(agentConfig.processors.k8sattributes.extract.labels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tag_name: "vlyv.organization.id",
					from: "namespace",
				}),
			]),
		);
		expect(agentConfig.processors["filter/tenant"].logs.log_record).toContain(
			'resource.attributes["vlyv.organization.id"] == nil',
		);
	});

	it("exports every signal and node log through one authenticated OTLP backend", () => {
		const unified = buildKubernetesObservabilityCollectorManifests({
			image: `otel/opentelemetry-collector-contrib@sha256:${"b".repeat(64)}`,
			otlp: {
				endpoint: "https://otlp-gateway.grafana.net/otlp",
				headers: { Authorization: "Basic instance-token" },
			},
		});
		const config = findManifest(unified, "ConfigMap");
		const secret = findManifest(unified, "Secret");
		const collector = JSON.parse(config.data["collector.json"]);
		const logAgent = JSON.parse(config.data["log-agent.json"]);

		expect(secret.data.OTLP_HEADER_0).toBe(
			Buffer.from("Basic instance-token").toString("base64"),
		);
		expect(JSON.stringify(config)).not.toContain("instance-token");
		expect(collector.exporters["otlphttp/platform"]).toEqual({
			endpoint: "https://otlp-gateway.grafana.net/otlp",
			headers: { Authorization: "${env:OTLP_HEADER_0}" },
		});
		for (const signal of ["metrics", "logs", "traces"]) {
			expect(collector.service.pipelines[signal].exporters).toContain(
				"otlphttp/platform",
			);
		}
		expect(logAgent.exporters["otlphttp/logs"]).toEqual(
			collector.exporters["otlphttp/platform"],
		);
	});

	it("rejects mutable images and empty backends", () => {
		expect(() =>
			buildKubernetesObservabilityCollectorManifests({
				image: "otel/opentelemetry-collector-contrib:latest",
				metrics: { endpoint: "https://mimir.vlyv.dev" },
			}),
		).toThrow("immutable digest");
		expect(() =>
			buildKubernetesObservabilityCollectorManifests({
				image: `otel/collector@sha256:${"a".repeat(64)}`,
			}),
		).toThrow("at least one backend");
	});
});
