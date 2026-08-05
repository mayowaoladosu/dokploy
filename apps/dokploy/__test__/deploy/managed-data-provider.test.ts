import {
	createHttpManagedDataProvider,
	filterManagedDataResourcesForScope,
} from "@dokploy/server/services/managed-data-provider";
import { describe, expect, it, vi } from "vitest";

describe("HTTP managed data provider", () => {
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
						connectionUri: "postgres://secret",
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
			idempotencyKey: "provision-1",
			organizationId: "organization-1",
			projectId: "project-1",
			environmentId: "environment-1",
			kind: "postgres",
			name: "primary",
			plan: "small",
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
});
