import {
	buildKubernetesBuildManifests,
	buildKubernetesRoutingManifests,
	buildKubernetesRuntimeManifests,
} from "@dokploy/server/services/kubernetes/manifests";
import { describe, expect, it } from "vitest";

const findManifest = (
	manifests: Array<Record<string, unknown>>,
	kind: string,
) => {
	const manifest = manifests.find((entry) => entry.kind === kind);
	if (!manifest) throw new Error(`${kind} manifest was not generated`);
	return manifest as any;
};

describe("Kubernetes runtime manifests", () => {
	const manifests = buildKubernetesRuntimeManifests({
		applicationId: "application-1",
		organizationId: "organization-1",
		appName: "example-app",
		namespace: "vlyv-app-abc",
		imageRef: "registry.example.com/apps/example@sha256:abc",
		replicas: 2,
		maxReplicas: 5,
		targetCpuUtilization: 70,
		environment: ["NODE_ENV=production", "TOKEN=a=b"],
		ports: [{ targetPort: 3000, protocol: "tcp" }],
		resources: {
			memoryLimitBytes: 536_870_912,
			memoryRequestBytes: 134_217_728,
			cpuLimitNano: 1_000_000_000,
			cpuRequestNano: 250_000_000,
		},
		runtimeClassName: "gvisor",
		nodeSelector: { "vlyv.dev/pool": "runtime" },
		domains: [{ host: "example.com", path: "/" }],
		gateway: { namespace: "gateway-system", name: "public" },
	});

	it("generates isolated, quota-bound, autoscaled resources", () => {
		expect(findManifest(manifests, "Namespace").metadata.labels).toMatchObject({
			"pod-security.kubernetes.io/enforce": "restricted",
		});
		expect(findManifest(manifests, "ResourceQuota").spec.hard).toMatchObject({
			"limits.cpu": "5000m",
			"limits.memory": "2560Mi",
		});
		expect(
			findManifest(manifests, "HorizontalPodAutoscaler").spec,
		).toMatchObject({
			minReplicas: 2,
			maxReplicas: 5,
		});
		expect(
			manifests.filter((manifest) => manifest.kind === "NetworkPolicy"),
		).toHaveLength(4);
		expect(findManifest(manifests, "PodDisruptionBudget").spec).toMatchObject({
			minAvailable: 1,
		});
	});

	it("uses immutable images, secret-backed env, and restricted pod security", () => {
		const deployment = findManifest(manifests, "Deployment");
		const podSpec = deployment.spec.template.spec;
		const container = podSpec.containers[0];
		expect(container.image).toBe(
			"registry.example.com/apps/example@sha256:abc",
		);
		expect(container.envFrom[0].secretRef.name).toBe("app-application-1-env");
		expect(container.securityContext).toMatchObject({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ["ALL"] },
			readOnlyRootFilesystem: true,
		});
		expect(podSpec).toMatchObject({
			automountServiceAccountToken: false,
			runtimeClassName: "gvisor",
		});
		expect(findManifest(manifests, "Secret").data).toEqual({
			NODE_ENV: Buffer.from("production").toString("base64"),
			TOKEN: Buffer.from("a=b").toString("base64"),
		});
	});

	it("publishes only the supplied verified domains through Gateway API", () => {
		expect(findManifest(manifests, "HTTPRoute").spec).toMatchObject({
			hostnames: ["example.com"],
			parentRefs: [{ namespace: "gateway-system", name: "public" }],
		});
	});
});

describe("Kubernetes build manifests", () => {
	const manifests = buildKubernetesBuildManifests({
		applicationId: "application-1",
		organizationId: "organization-1",
		deploymentId: "deployment-1",
		namespace: "vlyv-build-abc",
		appName: "example-app",
		builderImage: "registry.example.com/platform/builder@sha256:def",
		command: "set -e; echo build",
		localImageRef: "example-app:latest",
		runtimeImageRef: "registry.example.com/apps/example:latest",
		runtimeClassName: "gvisor",
		activeDeadlineSeconds: 900,
		secrets: {
			VLYV_REGISTRY_TEST_USERNAME: "robot",
			VLYV_REGISTRY_TEST_PASSWORD: "super-secret",
		},
		resources: {
			memoryLimitBytes: 4_294_967_296,
			memoryRequestBytes: 536_870_912,
			cpuLimitNano: 4_000_000_000,
			cpuRequestNano: 500_000_000,
		},
	});

	it("creates a one-shot restricted job with artifact termination metadata", () => {
		const job = findManifest(manifests, "Job");
		const podSpec = job.spec.template.spec;
		const builder = podSpec.containers[0];
		expect(job.spec).toMatchObject({
			backoffLimit: 0,
			activeDeadlineSeconds: 900,
		});
		expect(podSpec).toMatchObject({
			restartPolicy: "Never",
			automountServiceAccountToken: false,
			runtimeClassName: "gvisor",
		});
		expect(builder.image).toContain("@sha256:def");
		expect(builder.args[0]).toContain("/dev/termination-log");
		expect(builder.args[0]).toContain("dockerd-rootless.sh");
		expect(builder.args[0]).not.toContain("super-secret");
		expect(builder.envFrom[0].secretRef.name).toContain("credentials");
		expect(findManifest(manifests, "Secret").data).toMatchObject({
			VLYV_REGISTRY_TEST_PASSWORD:
				Buffer.from("super-secret").toString("base64"),
		});
		expect(builder.securityContext.capabilities.drop).toEqual(["ALL"]);
		expect(findManifest(manifests, "ResourceQuota").spec.hard).toHaveProperty(
			"count/jobs.batch",
			"1",
		);
	});
});

describe("Kubernetes TLS routing manifests", () => {
	it("creates cert-manager and per-app Gateway resources for verified hosts", () => {
		const routing = buildKubernetesRoutingManifests({
			applicationId: "application-1",
			organizationId: "organization-1",
			appName: "example-app",
			namespace: "vlyv-app-abc",
			gateway: {
				namespace: "gateway-system",
				name: "shared",
				className: "cilium",
				certIssuerName: "letsencrypt-production",
			},
			domains: [{ host: "example.com", path: "/" }],
			port: 3000,
		});

		expect(findManifest(routing, "Certificate").spec).toMatchObject({
			dnsNames: ["example.com"],
			issuerRef: { name: "letsencrypt-production", kind: "ClusterIssuer" },
		});
		expect(findManifest(routing, "Gateway").spec).toMatchObject({
			gatewayClassName: "cilium",
		});
		expect(findManifest(routing, "HTTPRoute").spec.parentRefs[0]).toMatchObject(
			{
				name: "app-application-1-gateway",
				namespace: "gateway-system",
			},
		);
	});
});
