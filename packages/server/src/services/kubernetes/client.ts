import {
	AppsV1Api,
	BatchV1Api,
	CoreV1Api,
	CustomObjectsApi,
	KubeConfig,
	type KubernetesObject,
	KubernetesObjectApi,
	PatchStrategy,
	type V1Deployment,
	type V1Job,
	type V1Pod,
} from "@kubernetes/client-node";

export type KubernetesClientConfig = {
	kubeconfig?: string | null;
	inCluster?: boolean;
};

export type KubernetesPodMetric = {
	name: string;
	timestamp: string;
	window: string;
	containers: Array<{
		name: string;
		usage: { cpu?: string; memory?: string };
	}>;
};

export interface KubernetesControlPlane {
	apply(manifests: KubernetesObject[]): Promise<void>;
	read(manifest: KubernetesObject): Promise<KubernetesObject | null>;
	delete(manifest: KubernetesObject): Promise<void>;
	readDeployment(namespace: string, name: string): Promise<V1Deployment | null>;
	readJob(namespace: string, name: string): Promise<V1Job | null>;
	listPods(namespace: string, labelSelector: string): Promise<V1Pod[]>;
	listPodMetrics(
		namespace: string | null,
		labelSelector: string,
	): Promise<KubernetesPodMetric[]>;
	readPodLogs(
		namespace: string,
		name: string,
		container?: string,
	): Promise<string>;
	setDeploymentReplicas(
		namespace: string,
		name: string,
		replicas: number,
	): Promise<void>;
	restartDeployment(namespace: string, name: string): Promise<void>;
	deleteNamespace(namespace: string): Promise<void>;
}

const errorStatusCode = (error: unknown) => {
	if (!error || typeof error !== "object") return undefined;
	const candidate = error as {
		code?: number;
		statusCode?: number;
		response?: { statusCode?: number; status?: number };
	};
	return (
		candidate.statusCode ??
		candidate.code ??
		candidate.response?.statusCode ??
		candidate.response?.status
	);
};

const isNotFound = (error: unknown) => errorStatusCode(error) === 404;
const isConflict = (error: unknown) => errorStatusCode(error) === 409;

const manifestIdentity = (manifest: KubernetesObject) => {
	const name = manifest.metadata?.name;
	if (!manifest.apiVersion || !manifest.kind || !name) {
		throw new Error("Kubernetes manifests require apiVersion, kind, and name");
	}
	return {
		apiVersion: manifest.apiVersion,
		kind: manifest.kind,
		metadata: {
			name,
			...(manifest.metadata?.namespace
				? { namespace: manifest.metadata.namespace }
				: {}),
		},
	};
};

export const createKubernetesControlPlane = (
	config: KubernetesClientConfig,
): KubernetesControlPlane => {
	const kubeConfig = new KubeConfig();
	try {
		if (config.kubeconfig) {
			kubeConfig.loadFromString(config.kubeconfig);
		} else if (config.inCluster) {
			kubeConfig.loadFromCluster();
		} else {
			throw new Error("missing credentials");
		}
	} catch {
		throw new Error("Kubernetes credentials are invalid or unavailable");
	}

	const objects = KubernetesObjectApi.makeApiClient(kubeConfig);
	const apps = kubeConfig.makeApiClient(AppsV1Api);
	const batch = kubeConfig.makeApiClient(BatchV1Api);
	const core = kubeConfig.makeApiClient(CoreV1Api);
	const custom = kubeConfig.makeApiClient(CustomObjectsApi);

	const applyOne = async (manifest: KubernetesObject) => {
		try {
			await objects.patch(
				manifest,
				undefined,
				undefined,
				"vlyv-control-plane",
				true,
				PatchStrategy.ServerSideApply,
			);
		} catch (error) {
			if (!isNotFound(error)) throw error;
			try {
				await objects.create(
					manifest,
					undefined,
					undefined,
					"vlyv-control-plane",
				);
			} catch (createError) {
				if (!isConflict(createError)) throw createError;
				await objects.patch(
					manifest,
					undefined,
					undefined,
					"vlyv-control-plane",
					true,
					PatchStrategy.ServerSideApply,
				);
			}
		}
	};

	return {
		apply: async (manifests) => {
			for (const manifest of manifests) {
				try {
					await applyOne(manifest);
				} catch {
					throw new Error(
						`Kubernetes ${manifest.kind || "resource"} ${manifest.metadata?.name || "unknown"} could not be applied`,
					);
				}
			}
		},
		read: async (manifest) => {
			try {
				return await objects.read(manifestIdentity(manifest));
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		delete: async (manifest) => {
			try {
				await objects.delete(
					manifestIdentity(manifest),
					undefined,
					undefined,
					0,
				);
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		},
		readDeployment: async (namespace, name) => {
			try {
				return await apps.readNamespacedDeployment({ name, namespace });
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		readJob: async (namespace, name) => {
			try {
				return await batch.readNamespacedJob({ name, namespace });
			} catch (error) {
				if (isNotFound(error)) return null;
				throw error;
			}
		},
		listPods: async (namespace, labelSelector) =>
			(
				await core.listNamespacedPod({
					namespace,
					labelSelector,
				})
			).items,
		listPodMetrics: async (namespace, labelSelector) => {
			const request = {
				group: "metrics.k8s.io",
				version: "v1beta1",
				plural: "pods",
				labelSelector,
			};
			const response = (
				namespace
					? await custom.listNamespacedCustomObject({ ...request, namespace })
					: await custom.listCustomObjectForAllNamespaces(request)
			) as {
				items?: KubernetesPodMetric[];
			};
			return response.items ?? [];
		},
		readPodLogs: async (namespace, name, container) =>
			core.readNamespacedPodLog({
				namespace,
				name,
				container,
				tailLines: 500,
			}),
		setDeploymentReplicas: async (namespace, name, replicas) => {
			await objects.patch(
				{
					apiVersion: "apps/v1",
					kind: "Deployment",
					metadata: { name, namespace },
					spec: { replicas: Math.max(replicas, 0) },
				} as KubernetesObject,
				undefined,
				undefined,
				undefined,
				undefined,
				PatchStrategy.MergePatch,
			);
		},
		restartDeployment: async (namespace, name) => {
			await objects.patch(
				{
					apiVersion: "apps/v1",
					kind: "Deployment",
					metadata: { name, namespace },
					spec: {
						template: {
							metadata: {
								annotations: {
									"vlyv.dev/restarted-at": new Date().toISOString(),
								},
							},
						},
					},
				} as KubernetesObject,
				undefined,
				undefined,
				undefined,
				undefined,
				PatchStrategy.MergePatch,
			);
		},
		deleteNamespace: async (namespace) => {
			try {
				await objects.delete({
					apiVersion: "v1",
					kind: "Namespace",
					metadata: { name: namespace },
				});
			} catch (error) {
				if (!isNotFound(error)) throw error;
			}
		},
	};
};
