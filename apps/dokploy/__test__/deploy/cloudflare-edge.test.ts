import {
	assertCloudflareEdgeConfig,
	type CloudflareEdgeConfig,
	createCloudflareEdgeClient,
	isHostnameInCloudflareZone,
} from "@dokploy/server/services/cloudflare-edge";
import { describe, expect, it, vi } from "vitest";

const config = (overrides: Partial<CloudflareEdgeConfig> = {}) => ({
	accountId: "account_12345678",
	zoneId: "zone_12345678",
	zoneName: "vlyv.dev",
	managedDomain: "apps.vlyv.dev",
	apiToken: "cloudflare-token-with-enough-entropy",
	originHostname: "origin.vlyv.dev",
	originTokenHash: `sha256:${"a".repeat(64)}`,
	customHostnamesEnabled: true,
	managedWafEnabled: true,
	cacheEnabled: true,
	geoRoutingEnabled: false,
	originLockdownEnabled: true,
	authenticatedOriginPullsEnabled: true,
	analyticsEnabled: true,
	cacheTtlSeconds: 3_600,
	browserTtlSeconds: 300,
	loadBalancerPoolIds: [],
	...overrides,
});

const envelope = (result: unknown, status = 200) =>
	new Response(JSON.stringify({ success: status < 400, result }), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const rulesetResponse = (phase: string) => ({
	id: `rules-${phase}`,
	phase,
	kind: "zone",
	rules: [],
});

describe("Cloudflare edge adapter", () => {
	it("validates provider identity and geo-routing prerequisites", () => {
		expect(() => assertCloudflareEdgeConfig(config())).not.toThrow();
		expect(() =>
			assertCloudflareEdgeConfig(config({ geoRoutingEnabled: true })),
		).toThrow("load-balancer pools");
		expect(isHostnameInCloudflareZone("app.vlyv.dev", "vlyv.dev")).toBe(true);
		expect(isHostnameInCloudflareZone("customer.example", "vlyv.dev")).toBe(
			false,
		);
	});

	it("publishes proxied DNS with origin protection and static-only caching", async () => {
		const requests: Array<{ url: string; method: string; body?: any }> = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			const method = init?.method || "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			requests.push({ url, method, body });
			if (url.includes("/dns_records?") && method === "GET")
				return envelope([]);
			if (url.endsWith("/dns_records") && method === "POST") {
				return envelope({ id: "dns-record-1", ...body });
			}
			if (url.includes("/rulesets/phases/") && method === "GET") {
				const phase = url.split("/phases/")[1]?.split("/")[0] || "phase";
				return envelope(rulesetResponse(phase));
			}
			if (url.includes("/rules") && method === "POST") {
				return envelope({ id: `rule-${requests.length}`, ...body });
			}
			if (url.endsWith("/purge_cache")) return envelope({ id: "purge" });
			throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
		});
		const client = createCloudflareEdgeClient({
			config: config(),
			fetcher,
			apiBase: "https://cloudflare.test/client/v4",
		});

		const publication = await client.publishHostname("app.vlyv.dev");

		expect(publication).toMatchObject({
			kind: "dns",
			resource: { id: "dns-record-1", proxied: true },
		});
		const rules = requests.filter(
			(request) => request.method === "POST" && request.url.includes("/rules"),
		);
		expect(JSON.stringify(rules)).toContain("x-vlyv-origin-token");
		expect(JSON.stringify(rules)).toContain(config().originTokenHash);
		const cacheRule = rules.find((request) =>
			request.body?.ref?.startsWith("vlyv-cache-"),
		);
		expect(cacheRule?.body.expression).toContain(
			"http.request.uri.path.extension",
		);
		expect(cacheRule?.body.expression).not.toContain('"html"');
	});

	it("waits for an out-of-zone custom hostname certificate", async () => {
		let hostnameReadCount = 0;
		const requests: Array<{ url: string; method: string; body?: any }> = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			const method = init?.method || "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			requests.push({ url, method, body });
			if (url.includes("custom_hostnames?hostname=")) return envelope([]);
			if (url.endsWith("/custom_hostnames") && method === "POST") {
				return envelope({
					id: "custom-1",
					status: "pending",
					ssl: { status: "pending" },
				});
			}
			if (url.endsWith("/custom_hostnames/custom-1")) {
				hostnameReadCount += 1;
				return envelope({
					id: "custom-1",
					status: "active",
					ssl: { status: "active" },
				});
			}
			if (url.includes("/rulesets/phases/") && method === "GET") {
				const phase = url.split("/phases/")[1]?.split("/")[0] || "phase";
				return envelope(rulesetResponse(phase));
			}
			if (url.includes("/rules") && method === "POST") {
				return envelope({ id: `rule-${requests.length}` });
			}
			if (url.endsWith("/purge_cache")) return envelope({ id: "purge" });
			throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
		});
		const client = createCloudflareEdgeClient({
			config: config(),
			fetcher,
			apiBase: "https://cloudflare.test/client/v4",
			pollIntervalMs: 1,
			sleep: async () => undefined,
		});

		const publication = await client.publishHostname("customer.example");

		expect(publication.kind).toBe("custom_hostname");
		expect(hostnameReadCount).toBe(1);
		const create = requests.find(
			(request) =>
				request.method === "POST" && request.url.endsWith("/custom_hostnames"),
		);
		expect(create?.body.ssl.method).toBe("http");
	});

	it("refuses to take over an unowned custom hostname", async () => {
		const fetcher = vi.fn<typeof fetch>(async () =>
			envelope([
				{
					id: "custom-owned-elsewhere",
					hostname: "customer.example",
					status: "active",
					ssl: { status: "active" },
				},
			]),
		);
		const client = createCloudflareEdgeClient({
			config: config(),
			fetcher,
			apiBase: "https://cloudflare.test/client/v4",
		});

		await expect(client.publishHostname("customer.example")).rejects.toThrow(
			"not managed by this vlyv publication",
		);
	});

	it("verifies zone ownership and installs the Cloudflare managed WAF", async () => {
		const requests: Array<{ url: string; method: string; body?: any }> = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			const method = init?.method || "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			requests.push({ url, method, body });
			if (url.endsWith("/user/tokens/verify")) {
				return envelope({ status: "active" });
			}
			if (url.endsWith(`/zones/${config().zoneId}`)) {
				return envelope({
					id: config().zoneId,
					name: config().zoneName,
					status: "active",
					account: { id: config().accountId },
				});
			}
			if (url.includes("/dns_records?name=")) {
				return envelope([{ id: "origin-dns", proxied: false }]);
			}
			if (url.includes("/dns_records?type=CNAME&name=")) return envelope([]);
			if (url.endsWith("/dns_records") && method === "POST") {
				return envelope({ id: "wildcard-dns", ...body });
			}
			if (url.includes("/settings/") && method === "PATCH") {
				return envelope({ id: "setting" });
			}
			if (
				url.endsWith("/origin_tls_client_auth/settings") &&
				method === "PUT"
			) {
				return envelope({ enabled: true });
			}
			if (url.includes("/zones/") && url.includes("/rulesets?")) {
				return envelope([
					{
						id: "managed-ruleset-1",
						name: "Cloudflare Managed Ruleset",
						kind: "managed",
					},
				]);
			}
			if (url.includes("/rulesets/phases/") && method === "GET") {
				return envelope(rulesetResponse("http_request_firewall_managed"));
			}
			if (url.includes("/rules") && method === "POST") {
				return envelope({ id: "waf-rule", ...body });
			}
			throw new Error(`Unexpected Cloudflare request: ${method} ${url}`);
		});
		const client = createCloudflareEdgeClient({
			config: config(),
			fetcher,
			apiBase: "https://cloudflare.test/client/v4",
		});

		await expect(client.verify()).resolves.toBe(true);
		await client.configureZoneSecurity();

		const wafRule = requests.find(
			(request) => request.body?.ref === "vlyv-managed-waf",
		);
		expect(wafRule?.body).toMatchObject({
			action: "execute",
			action_parameters: { id: "managed-ruleset-1" },
		});
		expect(
			requests.some(
				(request) =>
					request.method === "POST" &&
					request.body?.name === "*.apps.vlyv.dev" &&
					request.body?.proxied === true,
			),
		).toBe(true);
		expect(
			requests.some(
				(request) =>
					request.method === "PUT" &&
					request.url.endsWith("/origin_tls_client_auth/settings") &&
					request.body?.enabled === true,
			),
		).toBe(true);
	});

	it("aggregates request and egress usage without unsafe numeric coercion", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						data: {
							viewer: {
								zones: [
									{
										httpRequestsAdaptiveGroups: [
											{ count: 2, sum: { edgeResponseBytes: 100 } },
											{ count: 3, sum: { edgeResponseBytes: 250 } },
										],
									},
								],
							},
						},
					}),
					{ status: 200 },
				),
		);
		const client = createCloudflareEdgeClient({
			config: config(),
			fetcher,
			apiBase: "https://cloudflare.test/client/v4",
		});

		await expect(
			client.getUsage({
				hostname: "app.vlyv.dev",
				from: new Date(0),
				to: new Date(60_000),
			}),
		).resolves.toEqual({ requests: 5n, egressBytes: 350n });
	});

	it("requires static object-storage hostnames to be Cloudflare proxied", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(envelope([{ id: "asset-dns", proxied: true }]))
			.mockResolvedValueOnce(envelope([{ id: "asset-dns", proxied: false }]));
		const client = createCloudflareEdgeClient({
			config: config(),
			fetcher,
			apiBase: "https://cloudflare.test/client/v4",
		});

		await expect(client.verifyCdnHostname("assets.vlyv.dev")).resolves.toBe(
			true,
		);
		await expect(client.verifyCdnHostname("assets.vlyv.dev")).rejects.toThrow(
			"must be proxied",
		);
	});
});
