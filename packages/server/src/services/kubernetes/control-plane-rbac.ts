import type { KubernetesManifest } from "./manifests";

export const VLYV_CONTROL_PLANE_ROLE_BINDING = "vlyv-control-plane";
export const VLYV_NAMESPACE_MANAGER_ROLE = "vlyv-namespace-manager";

export const buildKubernetesControlPlaneRoleBinding = (
	namespace: string,
): KubernetesManifest => ({
	apiVersion: "rbac.authorization.k8s.io/v1",
	kind: "RoleBinding",
	metadata: {
		name: VLYV_CONTROL_PLANE_ROLE_BINDING,
		namespace,
		labels: { "app.kubernetes.io/managed-by": "vlyv" },
	},
	roleRef: {
		apiGroup: "rbac.authorization.k8s.io",
		kind: "ClusterRole",
		name: VLYV_NAMESPACE_MANAGER_ROLE,
	},
	subjects: [
		{
			kind: "ServiceAccount",
			name: "vlyv-control-plane",
			namespace: "vlyv-system",
		},
	],
});
