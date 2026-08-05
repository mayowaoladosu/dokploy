import {
	buildKubernetesBuildManifests,
	buildKubernetesPublisherManifests,
	buildKubernetesRoutingManifests,
	buildKubernetesRuntimeManifests,
	buildKubernetesSupplyChainManifests,
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
		healthCheck: {
			protocol: "http",
			port: 3000,
			path: "/healthz",
		},
		registrySecretName: "runtime-registry",
		registryCredentials: {
			server: "registry.example.com",
			username: "robot",
			password: "pull-secret",
		},
		readOnlyRootFilesystem: true,
		multiZone: true,
		domains: [{ host: "example.com", path: "/" }],
		gateway: {
			namespace: "gateway-system",
			name: "public",
			mode: "shared",
			externalDns: { enabled: true, ttl: 60 },
		},
	});

	it("generates isolated, quota-bound, autoscaled resources", () => {
		expect(findManifest(manifests, "Namespace").metadata.labels).toMatchObject({
			"pod-security.kubernetes.io/enforce": "restricted",
		});
		expect(findManifest(manifests, "ResourceQuota").spec.hard).toMatchObject({
			"limits.cpu": "6000m",
			"limits.memory": "3072Mi",
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
		const deploymentIndex = manifests.findIndex(
			(manifest) => manifest.kind === "Deployment",
		);
		expect(
			manifests
				.map((manifest, index) => ({ manifest, index }))
				.filter(({ manifest }) => manifest.kind === "NetworkPolicy")
				.every(({ index }) => index < deploymentIndex),
		).toBe(true);
		const ingress = manifests.find(
			(manifest: any) => manifest.metadata?.name === "allow-runtime-ingress",
		) as any;
		expect(JSON.stringify(ingress)).toContain("gateway-system");
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
			imagePullSecrets: [{ name: "runtime-registry" }],
		});
		expect(container.startupProbe.httpGet).toMatchObject({
			path: "/healthz",
			port: 3000,
			scheme: "HTTP",
		});
		expect(container.readinessProbe).toBeDefined();
		expect(container.livenessProbe).toBeDefined();
		expect(podSpec.topologySpreadConstraints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					topologyKey: "topology.kubernetes.io/zone",
				}),
			]),
		);
		expect(findManifest(manifests, "Secret").data).toEqual({
			NODE_ENV: Buffer.from("production").toString("base64"),
			TOKEN: Buffer.from("a=b").toString("base64"),
		});
		const pullSecret = manifests.find(
			(manifest: any) => manifest.metadata?.name === "runtime-registry",
		) as any;
		expect(pullSecret.type).toBe("kubernetes.io/dockerconfigjson");
		expect(
			Buffer.from(pullSecret.data[".dockerconfigjson"], "base64").toString(),
		).toContain("registry.example.com");
	});

	it("publishes only the supplied verified domains through Gateway API", () => {
		expect(findManifest(manifests, "HTTPRoute").spec).toMatchObject({
			hostnames: ["example.com"],
			parentRefs: [{ namespace: "gateway-system", name: "public" }],
		});
		expect(
			findManifest(manifests, "HTTPRoute").metadata.annotations,
		).toMatchObject({
			"external-dns.alpha.kubernetes.io/hostname": "example.com",
			"external-dns.alpha.kubernetes.io/ttl": "60",
		});
	});

	it("allows a single replica to drain during node maintenance", () => {
		const singleReplica = buildKubernetesRuntimeManifests({
			...({} as any),
			applicationId: "single-app",
			organizationId: "organization-1",
			appName: "single-app",
			namespace: "single-app",
			imageRef: "registry.example.com/app@sha256:abc",
			replicas: 1,
			maxReplicas: 1,
			targetCpuUtilization: 70,
			environment: [],
			ports: [{ targetPort: 3000 }],
			resources: {
				memoryLimitBytes: 1,
				memoryRequestBytes: 1,
				cpuLimitNano: 1,
				cpuRequestNano: 1,
			},
			domains: [],
		});
		expect(
			findManifest(singleReplica, "PodDisruptionBudget").spec,
		).toMatchObject({ maxUnavailable: 1 });
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
		sourceCommand: "set -e; echo clone",
		buildCommand: "set -e; echo build",
		sourceRunsInBuilder: false,
		localImageRef: "example-app:latest",
		runtimeClassName: "gvisor",
		activeDeadlineSeconds: 900,
		artifactStorageClassName: "encrypted-ephemeral",
		sourceSecrets: {
			VLYV_GITHUB_TOKEN: "source-secret",
		},
		buildSecrets: {
			NODE_ENV: "production",
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
		const sourceFetcher = podSpec.initContainers[0];
		const builder = podSpec.containers.find(
			(container: any) => container.name === "builder",
		);
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
		expect(builder.args[0]).toContain("dockerd-rootless.sh");
		expect(builder.args[0]).toContain("docker save");
		expect(builder.args[0]).not.toContain("source-secret");
		expect(builder.args[0]).not.toContain("registry-secret");
		expect(sourceFetcher.envFrom[0].secretRef.name).toContain("source");
		expect(builder.envFrom[0].secretRef.name).toContain("environment");
		expect(podSpec.containers.map((container: any) => container.name)).toEqual([
			"builder",
		]);
		expect(
			podSpec.volumes.find((volume: any) => volume.name === "artifacts"),
		).toHaveProperty("persistentVolumeClaim.claimName");
		expect(findManifest(manifests, "PersistentVolumeClaim").spec).toMatchObject(
			{
				storageClassName: "encrypted-ephemeral",
				accessModes: ["ReadWriteOnce"],
			},
		);
		const secrets = manifests.filter((manifest) => manifest.kind === "Secret");
		const buildSecret = secrets.find((manifest) =>
			manifest.metadata?.name?.includes("environment"),
		) as any;
		expect(buildSecret.data).toEqual({
			NODE_ENV: Buffer.from("production").toString("base64"),
		});
		expect(builder.securityContext.capabilities.drop).toEqual(["ALL"]);
		expect(builder.securityContext.capabilities.add).toEqual([
			"SETUID",
			"SETGID",
		]);
		expect(builder.securityContext.allowPrivilegeEscalation).toBe(true);
		expect(findManifest(manifests, "Namespace").metadata.labels).toMatchObject({
			"pod-security.kubernetes.io/enforce": "baseline",
			"pod-security.kubernetes.io/audit": "restricted",
		});
		expect(findManifest(manifests, "ResourceQuota").spec.hard).toHaveProperty(
			"count/jobs.batch",
			"3",
		);
		const jobIndex = manifests.findIndex((manifest) => manifest.kind === "Job");
		expect(
			manifests
				.map((manifest, index) => ({ manifest, index }))
				.filter(({ manifest }) => manifest.kind === "NetworkPolicy")
				.every(({ index }) => index < jobIndex),
		).toBe(true);
	});
});

describe("Kubernetes publisher manifests", () => {
	const manifests = buildKubernetesPublisherManifests({
		applicationId: "application-1",
		organizationId: "organization-1",
		deploymentId: "deployment-1",
		namespace: "vlyv-build-abc",
		publisherImage: `registry.example.com/platform/publisher@sha256:${"a".repeat(64)}`,
		runtimeImageRef: "registry.example.com/apps/example:deployment-1",
		runtimeClassName: "gvisor",
		activeDeadlineSeconds: 900,
		registrySecrets: {
			VLYV_PLATFORM_REGISTRY_HOST: "registry.example.com",
			VLYV_PLATFORM_REGISTRY_USERNAME: "robot",
			VLYV_PLATFORM_REGISTRY_PASSWORD: "registry-secret",
		},
		resources: {
			memoryLimitBytes: 2_147_483_648,
			memoryRequestBytes: 536_870_912,
			cpuLimitNano: 2_000_000_000,
			cpuRequestNano: 500_000_000,
		},
	});

	it("pushes the archive in a trusted Job without source or build secrets", () => {
		const job = findManifest(manifests, "Job");
		const publisher = job.spec.template.spec.containers[0];
		expect(publisher.args[0]).toContain("skopeo copy");
		expect(publisher.args[0]).toContain("/dev/termination-log");
		expect(publisher.args[0]).not.toContain("registry-secret");
		expect(publisher.envFrom[0].secretRef.name).toContain("registry");
		expect(job.spec.template.spec.volumes[0]).toHaveProperty(
			"persistentVolumeClaim.claimName",
		);
		expect(
			manifests.some((manifest) => manifest.kind === "ServiceAccount"),
		).toBe(true);
		expect(() =>
			buildKubernetesPublisherManifests({
				...({} as any),
				publisherImage: "registry.example.com/publisher:latest",
			}),
		).toThrow("immutable digest");
	});
});

describe("Kubernetes supply-chain manifests", () => {
	const manifests = buildKubernetesSupplyChainManifests({
		applicationId: "application-1",
		organizationId: "organization-1",
		deploymentId: "deployment-1",
		namespace: "vlyv-build-abc",
		verifierImage: `registry.example.com/platform/verifier@sha256:${"a".repeat(64)}`,
		imageRef: `registry.example.com/apps/example@sha256:${"b".repeat(64)}`,
		signingKeyRef: "awskms:///alias/vlyv-image-signing",
		maxCriticalVulnerabilities: 0,
		maxHighVulnerabilities: 3,
		ignoreUnfixed: true,
		runtimeClassName: "gvisor",
		serviceAccountAnnotations: {
			"eks.amazonaws.com/role-arn": "arn:aws:iam::123456789012:role/signer",
		},
		activeDeadlineSeconds: 600,
		registrySecrets: {
			VLYV_PLATFORM_REGISTRY_HOST: "registry.example.com",
			VLYV_PLATFORM_REGISTRY_USERNAME: "robot",
			VLYV_PLATFORM_REGISTRY_PASSWORD: "super-secret",
		},
		resources: {
			memoryLimitBytes: 2_147_483_648,
			memoryRequestBytes: 536_870_912,
			cpuLimitNano: 2_000_000_000,
			cpuRequestNano: 500_000_000,
		},
	});

	it("separates trusted verification from the untrusted source workspace", () => {
		const job = findManifest(manifests, "Job");
		const podSpec = job.spec.template.spec;
		const verifier = podSpec.containers[0];
		expect(verifier.image).toContain("@sha256:");
		expect(verifier.args[0]).toContain("syft");
		expect(verifier.args[0]).toContain("trivy sbom");
		expect(verifier.args[0]).toContain("cosign sign");
		expect(verifier.args[0]).toContain("cosign attest");
		expect(verifier.args[0]).toContain("cosign verify");
		expect(verifier.args[0]).not.toContain("super-secret");
		expect(verifier.volumeMounts.map((entry: any) => entry.name)).not.toContain(
			"workspace",
		);
		expect(podSpec).toMatchObject({
			automountServiceAccountToken: false,
			runtimeClassName: "gvisor",
		});
		expect(verifier.securityContext).toMatchObject({
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
		});
	});

	it("injects policy as values and registry credentials through a Secret", () => {
		const job = findManifest(manifests, "Job");
		const verifier = job.spec.template.spec.containers[0];
		expect(verifier.env).toEqual(
			expect.arrayContaining([
				{ name: "VLYV_MAX_CRITICAL", value: "0" },
				{ name: "VLYV_MAX_HIGH", value: "3" },
				{ name: "VLYV_IGNORE_UNFIXED", value: "true" },
			]),
		);
		expect(findManifest(manifests, "Secret").data).toMatchObject({
			VLYV_PLATFORM_REGISTRY_PASSWORD:
				Buffer.from("super-secret").toString("base64"),
		});
		expect(
			findManifest(manifests, "ServiceAccount").metadata.annotations,
		).toHaveProperty("eks.amazonaws.com/role-arn");
		expect(findManifest(manifests, "Secret").data).toMatchObject({
			VLYV_COSIGN_KEY_REF: Buffer.from(
				"awskms:///alias/vlyv-image-signing",
			).toString("base64"),
		});
		expect(
			verifier.env.some((entry: any) => entry.name === "VLYV_COSIGN_KEY_REF"),
		).toBe(false);
	});
	it("rejects mutable verifier images and image tags", () => {
		const base = {
			applicationId: "application-1",
			organizationId: "organization-1",
			deploymentId: "deployment-1",
			namespace: "vlyv-build-abc",
			verifierImage: `registry.example.com/verifier@sha256:${"a".repeat(64)}`,
			imageRef: `registry.example.com/app@sha256:${"b".repeat(64)}`,
			signingKeyRef: "awskms:///alias/key",
			maxCriticalVulnerabilities: 0,
			maxHighVulnerabilities: 0,
			ignoreUnfixed: false,
			activeDeadlineSeconds: 600,
			registrySecrets: {},
			resources: {
				memoryLimitBytes: 1,
				memoryRequestBytes: 1,
				cpuLimitNano: 1,
				cpuRequestNano: 1,
			},
		};
		expect(() =>
			buildKubernetesSupplyChainManifests({
				...base,
				verifierImage: "registry.example.com/verifier:latest",
			}),
		).toThrow("immutable digest");
		expect(() =>
			buildKubernetesSupplyChainManifests({
				...base,
				imageRef: "registry.example.com/app:latest",
			}),
		).toThrow("immutable digest");
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
				mode: "dedicated",
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
