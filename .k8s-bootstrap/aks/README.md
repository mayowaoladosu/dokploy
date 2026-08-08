# AKS production bootstrap

These assets bootstrap the provider-managed `vlyv-central-aks` cluster without
configuring DNS, a public hostname, or a certificate.

## Prerequisites

- Kubernetes 1.35 with Azure CNI Overlay and Cilium policy enforcement.
- Key Vault KMS, OIDC issuer, workload identity, and disabled local accounts.
- Three-zone `system` and `runtime` pools plus the scale-to-zero `build` pool.
- AKS-managed `kata-vm-isolation` RuntimeClass. Do not replace or re-apply it.
- The cluster kubelet identity must have `AcrPull` on the platform registry.

## Apply order

1. Apply `namespaces.yaml`.
2. Install Envoy Gateway `v1.8.3` with `envoy-gateway-values.yaml` in
   `envoy-gateway-system`.
3. Install cert-manager `v1.21.1` with `cert-manager-values.yaml` in
   `cert-manager`.
4. Apply `platform-rbac.yaml`, `observability-rbac.yaml`, and
   `workload-admission.yaml`.
5. Apply `envoy-proxy.yaml`, `gatewayclass.yaml`, and `gateway.yaml` in that
   order.
6. Reconcile the digest-pinned OpenTelemetry collector from the managed
   control plane after the Grafana OTLP backend is configured.

Both Helm releases use three replicas, zone spreading, disruption budgets,
restricted pod security, explicit resources, and system-pool placement. The
Envoy data plane uses an HPA range of 3–9 and a disruption budget of two.

## Domain boundary

`gateway.yaml` intentionally exposes only a domain-free HTTP listener so the
Gateway can be validated before DNS work. Add the HTTPS listener, production
ClusterIssuer, certificate, and external-dns only during the explicit
`vlyv.dev` domain phase. Do not introduce another domain.