import {
	clearManagedDataProviders,
	createHttpManagedDataProvider,
	filterManagedDataResourcesForScope,
	getManagedDataProvider,
	registerManagedDataProvider,
} from "@dokploy/server/services/managed-data-provider";
import { describe, expect, it, vi } from "vitest";

describe("HTTP managed data provider", () => {
	it("rejects inactive providers outside cleanup paths", () => {
		clearManagedDataProviders();
		const provider = createHttpManagedDataProvider({
			name: "offline",
			baseUrl: "https://data.example.com/",
			token: "provider-token",
			kinds: ["postgres"],
			validateEndpoint: async () => undefined,
		});
		registerManagedDataProvider(provider, [], undefined, false);

		expect(() => getManagedDataProvider("offline")).toThrow(
			"temporarily unavailable",
		);
		expect(getManagedDataProvider("offline", { allowInactive: true })).toBe(
			provider,
		);
		clearManagedDataProviders();
	});

	it("filters list results by API credential project and environment scopes", () => {
		const resources = [
			{ projectId: "project-1", environmentId: "environment-1" },
			{ projectId: "project-2", environmentId: "environment-2" },
		];
		expect(
			filterManagedDataResourcesForScope(resources, {
				projectIds: ["project-1"],
				environmentIds: ["environment-1"],
			} as never),
		).toEqual([resources[0]]);
	});

	it("rejects non-HTTPS provider endpoints", () => {
		expect(() =>
			createHttpManagedDataProvider({
				name: "test",
				baseUrl: "http://169.254.169.254/",
				token: "provider-token",
				kinds: ["postgres"],
			}),
		).toThrow("must use HTTPS");
	});

	it("sends authenticated idempotent provisioning requests", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						providerResourceId: "provider-resource-1",
						status: "ready",
						connectionUri:
							"postgres://app:secret@db.example.com/app?sslmode=require",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = createHttpManagedDataProvider({
			name: "test",
			baseUrl: "https://data.example.com/",
			token: "provider-token",
			kinds: ["postgres"],
			fetcher,
			validateEndpoint: async () => undefined,
		});

		const result = await provider.provision({
			managedDataResourceId: "managed-data-1",
			idempotencyKey: "provision-1",
			organizationId: "organization-1",
			projectId: "project-1",
			environmentId: "environment-1",
			regionId: "region-1",
			providerRegion: "us-east-1",
			kind: "postgres",
			name: "primary",
			plan: "starter",
			providerPlan: "small",
			storageLimitBytes: 1024n ** 3n,
			retentionDays: 7,
			pitrEnabled: true,
			highAvailability: true,
			poolingEnabled: true,
			replicas: 2,
			backupEnabled: true,
			backupIntervalHours: 24,
			backupRetentionDays: 7,
		});

		expect(result.status).toBe("ready");
		expect(fetcher).toHaveBeenCalledWith(
			new URL("https://data.example.com/v1/resources"),
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					authorization: "Bearer provider-token",
				}),
			}),
		);
	});

	it("rejects malformed provider responses", async () => {
		const provider = createHttpManagedDataProvider({
			name: "test",
			baseUrl: "https://data.example.com/",
			token: "provider-token",
			kinds: ["postgres"],
			fetcher: vi.fn(
				async () =>
					new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
			),
			validateEndpoint: async () => undefined,
		});

		await expect(provider.getStatus("provider-resource-1")).rejects.toThrow();
	});

	it("retrieves exact database usage samples for the billing reconciler", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						consumedBytes: "1099511627776",
						observedAt: "2026-08-05T12:00:00.000Z",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const provider = createHttpManagedDataProvider({
			name: "test",
			baseUrl: "https://data.example.com/",
			token: "provider-token",
			kinds: ["postgres"],
			fetcher,
			validateEndpoint: async () => undefined,
		});

		await expect(provider.getUsage("provider-resource-1")).resolves.toEqual({
			consumedBytes: 1_099_511_627_776n,
			observedAt: new Date("2026-08-05T12:00:00.000Z"),
		});
		expect(fetcher).toHaveBeenCalledWith(
			new URL(
				"https://data.example.com/v1/resources/provider-resource-1/usage",
			),
			expect.objectContaining({ method: "GET" }),
		);
	});
});
