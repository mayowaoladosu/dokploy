# vlyv production deployment

The managed build is environment-driven and fail-closed. Start from `apps/dokploy/.env.production.example`; never place real credentials in Git.

## 1. Revoke the exposed Polar token

Revoke any token previously shared outside the production secret store. Create a new production organization access token with the scopes needed for customers, products, checkouts, customer sessions, subscriptions, orders, and events.

## 2. Create external resources

1. **PostgreSQL control plane** — create a production PostgreSQL database and require TLS.
2. **Temporal** — create a Temporal Cloud namespace or an HA Temporal deployment.
3. **Polar** — create monthly and annual Hobby and Startup products. Seat-based prices are recommended when server capacity is billable.
4. **Neon** — create an API key and map the vlyv region slug to a Neon region.
5. **Azure Kubernetes Service** — create a three-zone cluster with separate system, runtime, and scale-to-zero build pools, then issue a restricted control-plane kubeconfig.
6. **OCI registry** — create a repository namespace and runtime pull secret.
7. **Cloudflare** — configure the `vlyv.dev` zone, scoped API token, origin hostname, and `apps.vlyv.dev` managed domain.
8. **Cloudflare R2** — create the static-assets bucket and connect `assets.vlyv.dev` as its custom domain.
9. **AWS S3/KMS** — create a private versioned archive bucket with default SSE-KMS encryption and all Block Public Access controls enabled.
10. **Grafana Cloud** — create a stack and copy the exact OTLP endpoint and encoded headers from its OpenTelemetry connection tile.
11. **Resend** — verify `vlyv.dev` and create an API key for SMTP.

## 3. Prepare Kubernetes

The bootstrap validates rather than silently installing security-critical cluster primitives. Before activation, the cluster needs:

- Gateway API CRDs, an accepted GatewayClass, and a programmed shared Gateway;
- cert-manager and a ready production ClusterIssuer;
- metrics-server, plus external-dns only after `vlyv.dev` is purchased and delegated;
- provider RuntimeClasses for runtime and build workloads;
- network-policy enforcement and Kubernetes Secret encryption at rest;
- correctly labeled runtime/build/system nodes;
- an artifact StorageClass;
- a KMS-backed signing key and digest-pinned builder, verifier, publisher, backup-worker, and OpenTelemetry Collector images.

For AKS, use the pinned, three-zone bootstrap assets and apply order in [.k8s-bootstrap/aks/README.md](.k8s-bootstrap/aks/README.md). AKS owns the `kata-vm-isolation` RuntimeClass; do not replace it with a custom RuntimeClass object.

Prepare and verify these capabilities before launching the tenant control plane. Production startup requires `PLATFORM_BOOTSTRAP_ACTIVATE=true` and fails closed when a prerequisite is unavailable.

## 4. Configure Polar

Set the webhook URL to:

`https://vlyv.dev/api/polar/webhook`

Subscribe to:

- `customer.state_changed`
- `customer.deleted`
- subscription lifecycle events, especially active, updated, past due, and revoked
- `order.paid`

For each usage metric you bill, create a Polar meter that filters the corresponding event and uses **Sum** over the `quantity` property. Default event names are:

- `vlyv.build_seconds`
- `vlyv.cpu_milliseconds`
- `vlyv.memory_byte_seconds`
- `vlyv.request_count`
- `vlyv.egress_bytes`
- `vlyv.storage_byte_hours`
- `vlyv.database_byte_seconds`

Set `POLAR_USAGE_CUTOVER_AT` once to the exact canonical UTC instant Polar starts metered billing, for example `2026-08-08T00:00:00.000Z`. Older local ledger events are intentionally not replayed onto the current invoice.

## 5. Populate deployment secrets

Copy every value from `apps/dokploy/.env.production.example` into the deployment platform and replace each `<...>` placeholder. In particular:

- keep `BETTER_AUTH_SECRET` and the distinct `ENCRYPTION_KEY` stable forever;
- deploy the control plane under the `vlyv-control-plane` service account so AKS rotates its projected token; never use the AKS admin kubeconfig in production;
- use the Grafana-provided percent-encoded OTLP header string;
- keep Cloudflare R2 and AWS archive credentials separate;
- use only PostgreSQL/Neon for managed tenant databases.

## 6. Deploy

Build `Dockerfile.cloud`. The container runs database migrations before starting the control plane. Startup then:

1. validates core, SMTP, Polar, and Temporal configuration;
2. reconciles Kubernetes, Cloudflare, R2, AWS archive storage, and Grafana records;
3. loads and verifies Neon;
4. validates independent database backup readiness;
5. starts Temporal and reconciliation loops;
6. exports usage events to Polar and telemetry to Grafana Cloud.

A failed provider verification intentionally prevents or degrades activation rather than accepting an insecure partial setup.

## 7. Verify

- Register and verify an account.
- Complete a Polar sandbox checkout before switching to production.
- Confirm a `customer.state_changed` delivery updates the organization plan.
- Deploy a sample application and verify its Kubernetes placement and hostname.
- Provision managed PostgreSQL and bind `DATABASE_URL` to the application.
- Upload static output and confirm delivery from the R2 custom domain.
- Create and restore a database backup; confirm S3 object KMS metadata.
- Confirm control-plane and workload metrics, logs, and traces in Grafana Cloud.
- Confirm a Polar usage event appears once when the same local event is replayed.
