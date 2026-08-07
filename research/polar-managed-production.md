# Polar and managed production integration research

Verified against primary sources and the installed SDK on 2026-08-06.

## Decisions

- Billing uses Polar's official preview SDK, pinned through the `@polar-sh/sdk/2026-04` export. The repository currently resolves `@polar-sh/sdk` to `1.0.0-alpha.16`; the versioned import fixes the API contract independently of package updates. [Polar TypeScript SDK](https://polar.sh/docs/integrate/sdk/typescript)
- A Polar organization access token is server-only and is read from `POLAR_ACCESS_TOKEN`. Production and sandbox are separate environments. [Polar TypeScript SDK](https://polar.sh/docs/integrate/sdk/typescript) · [Polar sandbox](https://polar.sh/docs/integrate/sandbox)
- Each local organization ID is the Polar `external_customer_id`. Polar creates or links the customer after checkout and returns that ID as `customer.external_id` in webhooks. [Polar Checkout API](https://polar.sh/docs/features/checkout/session.md)
- Billing access is synchronized from `customers.getStateExternal()`. Customer State contains active subscriptions, granted benefits, and active meter balances, and `customer.state_changed` is the canonical state-change webhook. [Polar Customer State](https://polar.sh/docs/integrate/customer-state.md)
- Webhooks are verified from the unparsed request body with the SDK's `webhooks.validateEvent()`. The implemented endpoint is `/api/polar/webhook`. [Polar webhook setup](https://polar.sh/docs/integrate/webhooks/endpoints.md) · [Polar SDK adapter reference](https://polar.sh/docs/integrate/sdk/adapters/nextjs.md)
- Usage export calls `polar.events.ingest()` with a deterministic `external_id`, the organization ID as `external_customer_id`, and integer `quantity` metadata. Polar treats `external_id` as a deduplication key and reports inserted and duplicate counts. [Polar event ingestion API](https://polar.sh/docs/api-reference/events/ingest-events.md)
- Polar meters should filter by each configured event name and use Sum aggregation over the `quantity` metadata property. Metadata properties are referenced directly, without a `metadata.` prefix. [Polar meters](https://polar.sh/docs/features/usage-based-billing/meters.md)

## Storage

- Cloudflare R2 exposes an S3-compatible endpoint at `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; its canonical S3 region is `auto`. [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- A production public R2 bucket should use a Cloudflare custom domain. The `r2.dev` endpoint is rate-limited and intended for non-production use. [Cloudflare R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- R2 does not implement the AWS SSE-KMS headers used by S3 `PutObject`. It therefore cannot satisfy the existing independent managed-database archive contract. [Cloudflare R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- Managed PostgreSQL archives remain on a separate private, versioned AWS S3 bucket with default SSE-KMS encryption, a dedicated KMS key, and all S3 Block Public Access controls enabled. AWS documents SSE-KMS as a distinct bucket/default or request-level encryption mode. [AWS S3 SSE-KMS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html)

## Observability

- Grafana Cloud is the hosted observability provider. Its OTLP endpoint accepts metrics, logs, and traces. The stack's OpenTelemetry connection tile supplies the exact `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and `OTEL_EXPORTER_OTLP_HEADERS` values. [Grafana Cloud OTLP](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/send-data-otlp/)
- With the base HTTP endpoint, OpenTelemetry SDKs append `/v1/metrics`, `/v1/logs`, and `/v1/traces`. The control plane and in-cluster collector use the same base endpoint and authenticated headers. [Grafana Cloud OTLP endpoint paths](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/send-data-otlp/#configure-the-otlp-endpoint-path-for-each-signal)
- Grafana recommends Grafana Alloy or another OpenTelemetry Collector distribution in production for buffering, enrichment, sampling, redaction, and routing. The managed Kubernetes bootstrap deploys a digest-pinned collector and log agent. [Grafana Cloud production architecture](https://grafana.com/docs/grafana-cloud/observe-and-act/send-data/otlp/send-data-otlp/#recommended-production-architecture)

## Kubernetes provider boundary

- The Azure AKS integration runs under a dedicated, restricted `vlyv-control-plane` service account. AKS projects and rotates the short-lived Kubernetes token in-cluster; no admin kubeconfig is stored in production.
- Activation verifies the Kubernetes capabilities required by this control plane: Gateway API, cert-manager issuer, metrics-server, optional external-dns, RuntimeClasses, isolated node labels, digest-pinned build/agent images, a registry, and KMS-backed supply-chain signing.
- The production AKS cluster uses Cilium NetworkPolicy, Key Vault KMS encryption, workload identity, and three availability zones. Production requires bootstrap activation and fails closed rather than weakening isolation.

## Security notes

- The Polar token previously pasted into chat is compromised and must be revoked. No value from chat was written to this repository.
- A dedicated `ENCRYPTION_KEY` protects encrypted infrastructure credentials in managed production. It and `BETTER_AUTH_SECRET` must be generated independently, backed up securely, and preserved across deployments.
- Real kubeconfigs, registry passwords, API tokens, KMS credentials, and OTLP headers belong only in the production secret store. The checked-in environment file contains placeholders only.
