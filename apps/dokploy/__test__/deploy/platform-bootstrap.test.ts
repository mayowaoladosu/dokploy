import {
	bootstrapManagedPlatformFromEnvironment,
	extractOtlpAuthorization,
	parseOtlpHeaders,
} from "@dokploy/server/services/platform-bootstrap";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("managed platform environment bootstrap", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("decodes Grafana Cloud OTLP headers without exposing them in URLs", () => {
		expect(
			parseOtlpHeaders(
				"Authorization=Basic%20aW5zdGFuY2U6dG9rZW4%3D,X-Scope-OrgID=tenant-1",
			),
		).toEqual({
			Authorization: "Basic aW5zdGFuY2U6dG9rZW4=",
			"X-Scope-OrgID": "tenant-1",
		});
	});

	it("rejects malformed or injectable OTLP headers", () => {
		expect(() => parseOtlpHeaders("Authorization")).toThrow(
			"OTLP headers are invalid",
		);
		expect(() =>
			parseOtlpHeaders("Authorization=Basic%20token%0D%0AX-Injected%3Ayes"),
		).toThrow("OTLP headers are invalid");
		expect(() => parseOtlpHeaders("Bad%20Header=value")).toThrow(
			"OTLP headers are invalid",
		);
	});

	it("separates the Grafana credential for encrypted persistence", () => {
		expect(
			extractOtlpAuthorization({
				Authorization: "Basic aW5zdGFuY2U6dG9rZW4=",
				"X-Scope-OrgID": "tenant-1",
			}),
		).toEqual({
			authScheme: "Basic",
			authToken: "aW5zdGFuY2U6dG9rZW4=",
			headers: { "X-Scope-OrgID": "tenant-1" },
		});
		expect(() => extractOtlpAuthorization({})).toThrow(
			"must include Authorization",
		);
	});

	it("is a side-effect-free no-op unless explicitly enabled", async () => {
		vi.stubEnv("PLATFORM_BOOTSTRAP_ENABLED", "false");
		await expect(bootstrapManagedPlatformFromEnvironment()).resolves.toEqual({
			enabled: false,
		});
	});

	it("rejects invalid enablement and a managed bootstrap in self-hosted mode", async () => {
		vi.stubEnv("PLATFORM_BOOTSTRAP_ENABLED", "sometimes");
		await expect(bootstrapManagedPlatformFromEnvironment()).rejects.toThrow(
			"PLATFORM_BOOTSTRAP_ENABLED must be true or false",
		);

		vi.stubEnv("PLATFORM_BOOTSTRAP_ENABLED", "true");
		await expect(bootstrapManagedPlatformFromEnvironment()).rejects.toThrow(
			"requires PLATFORM_MODE=managed",
		);
	});
});
