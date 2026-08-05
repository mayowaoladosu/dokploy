import {
	createKubernetesControlPlane,
	type KubernetesControlPlane,
} from "@dokploy/server/services/kubernetes/client";
import {
	buildKubernetesRuntimeManifests,
	kubernetesApplicationResourceName,
} from "@dokploy/server/services/kubernetes/manifests";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const describeLive =
	process.env.KUBERNETES_INTEGRATION_TEST === "true" ? describe : describe.skip;

describeLive("Kubernetes live manifest validation", () => {
	const namespace = `vlyv-live-${Date.now()}`;
	const applicationId = `live-${Date.now()}`;
	let client: KubernetesControlPlane;

	beforeAll(() => {
		const kubeconfig = process.env.KUBECONFIG_CONTENT;
		if (!kubeconfig) throw new Error("KUBECONFIG_CONTENT is required");
		client = createKubernetesControlPlane({ kubeconfig });
	});

	afterAll(async () => {
		await client?.deleteNamespace(namespace);
	});

	it("server-side applies the isolated runtime resource set", async () => {
		await client.apply(
			buildKubernetesRuntimeManifests({
				applicationId,
				organizationId: "live-organization",
				appName: "live-application",
				namespace,
				imageRef: "registry.k8s.io/pause:3.10",
				replicas: 1,
				maxReplicas: 2,
				targetCpuUtilization: 70,
				environment: ["NODE_ENV=production"],
				ports: [{ targetPort: 3000, protocol: "tcp" }],
				resources: {
					memoryLimitBytes: 128 * 1024 ** 2,
					memoryRequestBytes: 32 * 1024 ** 2,
					cpuLimitNano: 500_000_000,
					cpuRequestNano: 50_000_000,
				},
				healthCheck: { protocol: "tcp", port: 3000 },
				domains: [],
			}),
		);

		await expect(
			client.readDeployment(
				namespace,
				kubernetesApplicationResourceName(applicationId),
			),
		).resolves.not.toBeNull();
		await expect(
			client.read({
				apiVersion: "policy/v1",
				kind: "PodDisruptionBudget",
				metadata: {
					name: kubernetesApplicationResourceName(applicationId),
					namespace,
				},
			}),
		).resolves.not.toBeNull();
	}, 60_000);
});
