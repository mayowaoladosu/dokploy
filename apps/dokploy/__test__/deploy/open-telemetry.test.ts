import { openTelemetryConfiguration } from "@dokploy/server/telemetry/open-telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";

const environmentKeys = [
	"NODE_ENV",
	"OTEL_ENABLED",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_PROMETHEUS_ENABLED",
	"OTEL_PROMETHEUS_HOST",
	"OTEL_PROMETHEUS_PORT",
	"OTEL_PROMETHEUS_ENDPOINT",
	"OTEL_SERVICE_NAME",
];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const key of environmentKeys) delete process.env[key];
});

describe("OpenTelemetry configuration", () => {
	it("is opt-in outside production and provides local Prometheus defaults", () => {
		vi.stubEnv("NODE_ENV", "test");
		const config = openTelemetryConfiguration();
		expect(config).toMatchObject({
			enabled: false,
			serviceName: "vlyv-control-plane",
			prometheusEnabled: true,
			prometheusHost: "127.0.0.1",
			prometheusPort: 9464,
			prometheusEndpoint: "/metrics",
		});
	});

	it("validates production exporters and custom endpoints", () => {
		vi.stubEnv("NODE_ENV", "production");
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://otel.vlyv.dev");
		vi.stubEnv("OTEL_PROMETHEUS_ENABLED", "false");
		vi.stubEnv("OTEL_SERVICE_NAME", "vlyv-api");
		expect(openTelemetryConfiguration()).toMatchObject({
			enabled: true,
			serviceName: "vlyv-api",
			prometheusEnabled: false,
			otlpEndpoint: "https://otel.vlyv.dev",
		});
	});

	it("rejects invalid ports, paths, and credential-bearing endpoints", () => {
		vi.stubEnv("OTEL_PROMETHEUS_PORT", "70000");
		expect(() => openTelemetryConfiguration()).toThrow("OTEL_PROMETHEUS_PORT");
		vi.stubEnv("OTEL_PROMETHEUS_PORT", "9464");
		vi.stubEnv("OTEL_PROMETHEUS_ENDPOINT", "metrics");
		expect(() => openTelemetryConfiguration()).toThrow("absolute path");
		vi.stubEnv("OTEL_PROMETHEUS_ENDPOINT", "/metrics");
		vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://user:secret@otel.test");
		expect(() => openTelemetryConfiguration()).toThrow("OTLP endpoint");
	});
});
