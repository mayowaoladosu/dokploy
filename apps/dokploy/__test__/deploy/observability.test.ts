import {
	buildScopedLogQuery,
	buildScopedMetricsQuery,
	normalizeObservabilityEndpoint,
	observabilityResourceId,
	observabilityTenantId,
} from "@dokploy/server/services/observability";
import { describe, expect, it } from "vitest";

describe("tenant observability authorization", () => {
	it("derives opaque stable tenant identities", () => {
		const tenant = observabilityTenantId("organization-1");
		expect(tenant).toMatch(/^[a-f0-9]{32}$/);
		expect(tenant).toBe(observabilityTenantId("organization-1"));
		expect(tenant).not.toBe(observabilityTenantId("organization-2"));
		expect(tenant).not.toContain("organization-1");
	});

	it("forces organization scoping into PromQL and LogQL", () => {
		const tenant = observabilityTenantId("organization-1");
		const metrics = buildScopedMetricsQuery({
			organizationId: "organization-1",
			metric: "vlyv_release_events_total",
			applicationId: "application-1",
			deploymentId: "deployment-1",
		});
		const logs = buildScopedLogQuery({
			organizationId: "organization-1",
			applicationId: "application-1",
			deploymentId: "deployment-1",
			search: 'failed "safely"',
		});

		expect(metrics).toContain(`vlyv_organization_id="${tenant}"`);
		expect(metrics).toContain(
			`vlyv_application_id="${observabilityResourceId("application", "application-1")}"`,
		);
		expect(logs).toContain(`vlyv_organization_id = "${tenant}"`);
		expect(logs).toContain(
			`vlyv_deployment_id = "${observabilityResourceId("deployment", "deployment-1")}"`,
		);
		expect(logs).toContain('failed \\"safely\\"');
	});

	it("rejects query injection and unsafe backend endpoints", () => {
		expect(() =>
			buildScopedMetricsQuery({
				organizationId: "organization-1",
				metric: 'up{organization="other"}',
			}),
		).toThrow("Metric name is invalid");
		expect(() =>
			buildScopedLogQuery({
				organizationId: "organization-1",
				applicationId: 'app"} |= "secret',
			}),
		).toThrow("application filter is invalid");
		expect(() =>
			normalizeObservabilityEndpoint("http://loki.example.com", {}),
		).toThrow("must use HTTPS");
		expect(() =>
			normalizeObservabilityEndpoint("https://127.0.0.1:3100", {}),
		).toThrow("explicit operator approval");
		expect(
			normalizeObservabilityEndpoint("http://loki.monitoring.svc:3100", {
				allowInsecure: true,
				allowPrivateEndpoint: true,
			}),
		).toBe("http://loki.monitoring.svc:3100");
	});

	it("rejects plaintext authorization in OTLP metadata", async () => {
		const { createPlatformObservabilityBackend } = await import(
			"@dokploy/server/services/observability"
		);
		await expect(
			createPlatformObservabilityBackend({
				name: "unsafe-otlp",
				kind: "otlp",
				endpoint: "https://otlp.example.com/otlp",
				metadata: {
					retentionManagedExternally: true,
					otlpHeaders: { Authorization: "Basic plaintext" },
				},
			}),
		).rejects.toThrow("authorization must use the encrypted auth token");
	});
});
