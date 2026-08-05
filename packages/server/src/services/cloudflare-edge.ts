import { createHash } from "node:crypto";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const HOSTNAME_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;

export type CloudflareEdgeConfig = {
	accountId: string;
	zoneId: string;
	zoneName: string;
	managedDomain: string;
	apiToken: string;
	originHostname: string;
	originTokenHash: string;
	customHostnamesEnabled: boolean;
	managedWafEnabled: boolean;
	cacheEnabled: boolean;
	geoRoutingEnabled: boolean;
	originLockdownEnabled: boolean;
	authenticatedOriginPullsEnabled: boolean;
	analyticsEnabled: boolean;
	cacheTtlSeconds: number;
	browserTtlSeconds: number;
	loadBalancerPoolIds: string[];
	loadBalancerFallbackPoolId?: string;
	loadBalancerRegionPools?: Record<string, string[]>;
};

export type CloudflareResource = {
	id: string;
	name?: string;
	hostname?: string;
	status?: string;
	proxied?: boolean;
	content?: string;
	comment?: string;
	description?: string;
	ssl?: { status?: string };
	account?: { id?: string };
};

export type CloudflareUsage = {
	requests: bigint;
	egressBytes: bigint;
};

export type CloudflareStaticDelivery = {
	publicBaseUrl: string;
	mode: "container" | "static" | "hybrid";
	routePrefixes: string[];
};

type CloudflareEnvelope<T> = {
	success: boolean;
	result: T;
	errors?: Array<{ code?: number; message?: string }>;
};

type CloudflareRule = {
	id?: string;
	ref?: string;
	action: string;
	action_parameters?: Record<string, unknown>;
	expression: string;
	description?: string;
	enabled?: boolean;
	logging?: Record<string, unknown>;
};

type CloudflareRuleset = {
	id: string;
	name?: string;
	description?: string;
	kind?: string;
	phase?: string;
	rules?: CloudflareRule[];
};

type CloudflareRulesetPhase =
	| "http_request_transform"
	| "http_request_late_transform"
	| "http_request_origin"
	| "http_request_cache_settings"
	| "http_request_firewall_managed";

const normalizedHostname = (value: string, field = "hostname") => {
	const normalized = value.trim().toLowerCase().replace(/\.$/, "");
	if (!HOSTNAME_PATTERN.test(normalized)) {
		throw new Error(`Cloudflare ${field} is invalid`);
	}
	return normalized;
};

const assertIdentifier = (value: string, field: string) => {
	if (!IDENTIFIER_PATTERN.test(value)) {
		throw new Error(`Cloudflare ${field} is invalid`);
	}
	return value;
};

export const isHostnameInCloudflareZone = (
	hostname: string,
	zoneName: string,
) => {
	const host = normalizedHostname(hostname);
	const zone = normalizedHostname(zoneName, "zone name");
	return host === zone || host.endsWith(`.${zone}`);
};

const expressionString = (value: string) =>
	`"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const STATIC_EXTENSIONS = [
	"avif",
	"css",
	"eot",
	"gif",
	"ico",
	"jpeg",
	"jpg",
	"js",
	"map",
	"mp3",
	"mp4",
	"ogg",
	"otf",
	"pdf",
	"png",
	"svg",
	"ttf",
	"txt",
	"wasm",
	"webm",
	"webp",
	"woff",
	"woff2",
	"xml",
];
const STATIC_EXTENSION_EXPRESSION = `(${STATIC_EXTENSIONS.map(
	(extension) =>
		`ends_with(lower(raw.http.request.uri.path), ${expressionString(`.${extension}`)})`,
).join(" or ")})`;

const normalizeStaticDelivery = (
	hostname: string,
	delivery: CloudflareStaticDelivery,
) => {
	const url = new URL(delivery.publicBaseUrl);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Cloudflare static delivery requires a clean HTTPS URL");
	}
	const originHostname = normalizedHostname(
		url.hostname,
		"static origin hostname",
	);
	if (originHostname === normalizedHostname(hostname)) {
		throw new Error(
			"Cloudflare static origin must not recurse to the app host",
		);
	}
	const routePrefixes = Array.from(new Set(delivery.routePrefixes)).sort();
	if (routePrefixes.length === 0 || routePrefixes.length > 32) {
		throw new Error("Cloudflare static route prefixes are invalid");
	}
	for (const prefix of routePrefixes) {
		if (
			!prefix.startsWith("/") ||
			prefix.includes("\\") ||
			prefix.includes("\0") ||
			prefix.length > 2_048
		) {
			throw new Error("Cloudflare static route prefix is invalid");
		}
	}
	return {
		originHostname,
		basePath: url.pathname.replace(/\/+$/, ""),
		mode: delivery.mode,
		routePrefixes,
	};
};

export const cloudflareStaticRouteExpression = (
	hostname: string,
	delivery: CloudflareStaticDelivery,
) => {
	const normalized = normalizeStaticDelivery(hostname, delivery);
	const terms = normalized.routePrefixes.map((value) => {
		const prefix = value === "/" ? "/" : value.replace(/\/+$/, "");
		if (prefix === "/") {
			return `((raw.http.request.uri.path eq "/index.html" or ${STATIC_EXTENSION_EXPRESSION}) and not starts_with(raw.http.request.uri.path, "/api/"))`;
		}
		return `(raw.http.request.uri.path eq ${expressionString(prefix)} or starts_with(raw.http.request.uri.path, ${expressionString(`${prefix}/`)}))`;
	});
	return `(http.host eq ${expressionString(normalizedHostname(hostname))} and http.request.method in {"GET" "HEAD"} and (${terms.join(" or ")}))`;
};

const ruleRef = (prefix: string, hostname: string) =>
	`vlyv-${prefix}-${createHash("sha256")
		.update(hostname)
		.digest("hex")
		.slice(0, 20)}`;

const exactAnalyticsInteger = (value: number | undefined, field: string) => {
	if (!Number.isSafeInteger(value) || (value ?? -1) < 0) {
		throw new Error(`Cloudflare analytics ${field} is not an exact integer`);
	}
	return BigInt(value as number);
};

const writableRule = (rule: CloudflareRule): CloudflareRule => ({
	ref: rule.ref,
	action: rule.action,
	action_parameters: rule.action_parameters,
	expression: rule.expression,
	description: rule.description,
	enabled: rule.enabled ?? true,
	logging: rule.logging,
});

export const assertCloudflareEdgeConfig = (config: CloudflareEdgeConfig) => {
	assertIdentifier(config.accountId, "account ID");
	assertIdentifier(config.zoneId, "zone ID");
	normalizedHostname(config.zoneName, "zone name");
	const managedDomain = normalizedHostname(
		config.managedDomain,
		"managed domain",
	);
	if (!isHostnameInCloudflareZone(managedDomain, config.zoneName)) {
		throw new Error("Cloudflare managed domain must belong to its zone");
	}
	normalizedHostname(config.originHostname, "origin hostname");
	if (config.apiToken.trim().length < 20) {
		throw new Error("Cloudflare API token is invalid");
	}
	if (!/^sha256:[a-f0-9]{64}$/.test(config.originTokenHash)) {
		throw new Error("Cloudflare origin token hash is invalid");
	}
	if (
		!Number.isSafeInteger(config.cacheTtlSeconds) ||
		config.cacheTtlSeconds < 1 ||
		config.cacheTtlSeconds > 31_536_000
	) {
		throw new Error("Cloudflare cache TTL is invalid");
	}
	if (
		!Number.isSafeInteger(config.browserTtlSeconds) ||
		config.browserTtlSeconds < 0 ||
		config.browserTtlSeconds > 31_536_000
	) {
		throw new Error("Cloudflare browser TTL is invalid");
	}
	if (config.geoRoutingEnabled) {
		if (
			config.loadBalancerPoolIds.length === 0 ||
			!config.loadBalancerFallbackPoolId
		) {
			throw new Error(
				"Cloudflare geo-routing requires default and fallback load-balancer pools",
			);
		}
		for (const poolId of [
			...config.loadBalancerPoolIds,
			config.loadBalancerFallbackPoolId,
			...Object.values(config.loadBalancerRegionPools ?? {}).flat(),
		]) {
			assertIdentifier(poolId, "load-balancer pool ID");
		}
	}
};

export const createCloudflareEdgeClient = ({
	config,
	fetcher = fetch,
	apiBase = CLOUDFLARE_API_BASE,
	pollIntervalMs = 2_000,
	activationTimeoutMs = 120_000,
	sleep = (durationMs: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
}: {
	config: CloudflareEdgeConfig;
	fetcher?: typeof fetch;
	apiBase?: string;
	pollIntervalMs?: number;
	activationTimeoutMs?: number;
	sleep?: (durationMs: number) => Promise<void>;
}) => {
	assertCloudflareEdgeConfig(config);
	if (new URL(apiBase).protocol !== "https:") {
		throw new Error("Cloudflare API endpoint must use HTTPS");
	}

	const request = async <T>(
		path: string,
		options: { method?: string; body?: unknown; allowNotFound?: boolean } = {},
	): Promise<T | null> => {
		const response = await fetcher(`${apiBase}${path}`, {
			method: options.method ?? "GET",
			headers: {
				Authorization: `Bearer ${config.apiToken}`,
				"Content-Type": "application/json",
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 404 && options.allowNotFound) return null;
		const envelope = (await response
			.json()
			.catch(() => null)) as CloudflareEnvelope<T> | null;
		if (!response.ok || !envelope?.success) {
			const code = envelope?.errors?.[0]?.code;
			throw new Error(
				`Cloudflare API request failed${code ? ` (${code})` : ""}`,
			);
		}
		return envelope.result;
	};

	const list = async <T>(path: string) => (await request<T[]>(path)) ?? [];

	const upsertEntrypointRule = async (
		phase: CloudflareRulesetPhase,
		rule: CloudflareRule,
	) => {
		const path = `/zones/${encodeURIComponent(config.zoneId)}/rulesets/phases/${phase}/entrypoint`;
		const current = await request<CloudflareRuleset>(path, {
			allowNotFound: true,
		});
		if (!current) {
			return request<CloudflareRuleset>(
				`/zones/${encodeURIComponent(config.zoneId)}/rulesets`,
				{
					method: "POST",
					body: {
						name: `vlyv ${phase}`,
						description: `vlyv managed ${phase} rules`,
						kind: "zone",
						phase,
						rules: [writableRule(rule)],
					},
				},
			);
		}
		const existing = current.rules?.find(
			(candidate) => candidate.ref === rule.ref,
		);
		if (existing?.id) {
			return request<CloudflareRule>(
				`/zones/${encodeURIComponent(config.zoneId)}/rulesets/${encodeURIComponent(current.id)}/rules/${encodeURIComponent(existing.id)}`,
				{ method: "PATCH", body: writableRule(rule) },
			);
		}
		return request<CloudflareRule>(
			`/zones/${encodeURIComponent(config.zoneId)}/rulesets/${encodeURIComponent(current.id)}/rules`,
			{ method: "POST", body: writableRule(rule) },
		);
	};

	const deleteEntrypointRule = async (
		phase: CloudflareRulesetPhase,
		ref: string,
	) => {
		const path = `/zones/${encodeURIComponent(config.zoneId)}/rulesets/phases/${phase}/entrypoint`;
		const current = await request<CloudflareRuleset>(path, {
			allowNotFound: true,
		});
		const existing = current?.rules?.find((candidate) => candidate.ref === ref);
		if (!current || !existing?.id) return;
		await request(
			`/zones/${encodeURIComponent(config.zoneId)}/rulesets/${encodeURIComponent(current.id)}/rules/${encodeURIComponent(existing.id)}`,
			{ method: "DELETE", allowNotFound: true },
		);
	};

	const ensureDnsRecord = async (hostname: string) => {
		const host = normalizedHostname(hostname);
		const origin = normalizedHostname(config.originHostname, "origin hostname");
		const records = await list<CloudflareResource>(
			`/zones/${encodeURIComponent(config.zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(host)}`,
		);
		const existing = records[0];
		if (existing && existing.comment !== "Managed by vlyv") {
			throw new Error(`Cloudflare DNS record ${host} is not managed by vlyv`);
		}
		const payload = {
			type: "CNAME",
			name: host,
			content: origin,
			proxied: true,
			ttl: 1,
			comment: "Managed by vlyv",
		};
		if (existing) {
			return {
				resource: (await request<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
					{ method: "PUT", body: payload },
				)) as CloudflareResource,
				created: false,
			};
		}
		return {
			resource: (await request<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}/dns_records`,
				{ method: "POST", body: payload },
			)) as CloudflareResource,
			created: true,
		};
	};

	const ensureManagedWildcard = async () => {
		const name = `*.${normalizedHostname(config.managedDomain, "managed domain")}`;
		const origin = normalizedHostname(config.originHostname, "origin hostname");
		const records = await list<CloudflareResource>(
			`/zones/${encodeURIComponent(config.zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(name)}`,
		);
		const payload = {
			type: "CNAME",
			name,
			content: origin,
			proxied: true,
			ttl: 1,
			comment: "Managed wildcard for vlyv applications",
		};
		const existing = records[0];
		if (existing) {
			return request<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
				{ method: "PUT", body: payload },
			);
		}
		return request<CloudflareResource>(
			`/zones/${encodeURIComponent(config.zoneId)}/dns_records`,
			{ method: "POST", body: payload },
		);
	};

	const ensureCustomHostname = async (
		hostname: string,
		expectedResourceId?: string | null,
	) => {
		if (!config.customHostnamesEnabled) {
			throw new Error("Cloudflare custom hostnames are not enabled");
		}
		const host = normalizedHostname(hostname);
		const existing = (
			await list<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames?hostname=${encodeURIComponent(host)}`,
			)
		)[0];
		if (existing && existing.id !== expectedResourceId) {
			throw new Error(
				`Cloudflare custom hostname ${host} is not managed by this vlyv publication`,
			);
		}
		const payload = {
			hostname: host,
			custom_origin_server: config.originHostname,
			ssl: {
				method: "http",
				type: "dv",
				settings: {
					http2: "on",
					min_tls_version: "1.2",
					tls_1_3: "on",
				},
			},
		};
		const created = existing
			? await request<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames/${encodeURIComponent(existing.id)}`,
					{ method: "PATCH", body: payload },
				)
			: await request<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames`,
					{ method: "POST", body: payload },
				);
		if (!created) throw new Error("Cloudflare custom hostname was not created");
		const deadline = Date.now() + activationTimeoutMs;
		let latest = created;
		while (Date.now() < deadline) {
			if (latest.status === "active" && latest.ssl?.status === "active") {
				return { resource: latest, created: !existing };
			}
			if (latest.status === "moved" || latest.status === "blocked") {
				throw new Error("Cloudflare custom hostname was rejected");
			}
			await sleep(pollIntervalMs);
			latest = (await request<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames/${encodeURIComponent(created.id)}`,
			)) as CloudflareResource;
		}
		throw new Error(
			`Cloudflare custom hostname ${host} did not activate within ${activationTimeoutMs}ms`,
		);
	};

	const ensureLoadBalancer = async (hostname: string) => {
		const host = normalizedHostname(hostname);
		const existing = (
			await list<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}/load_balancers?search=${encodeURIComponent(host)}`,
			)
		).find((candidate) => candidate.name === host);
		if (existing && existing.description !== "Managed by vlyv") {
			throw new Error(
				`Cloudflare load balancer ${host} is not managed by vlyv`,
			);
		}
		const payload = {
			name: host,
			description: "Managed by vlyv",
			default_pools: config.loadBalancerPoolIds,
			fallback_pool: config.loadBalancerFallbackPoolId,
			region_pools: config.loadBalancerRegionPools,
			proxied: true,
			ttl: 30,
			enabled: true,
		};
		if (existing) {
			return {
				resource: (await request<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/load_balancers/${encodeURIComponent(existing.id)}`,
					{ method: "PUT", body: payload },
				)) as CloudflareResource,
				created: false,
			};
		}
		return {
			resource: (await request<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}/load_balancers`,
				{ method: "POST", body: payload },
			)) as CloudflareResource,
			created: true,
		};
	};

	const ensureOriginProtection = async (hostname: string) => {
		if (!config.originLockdownEnabled) return;
		const host = normalizedHostname(hostname);
		await upsertEntrypointRule("http_request_late_transform", {
			ref: ruleRef("origin", host),
			action: "rewrite",
			action_parameters: {
				headers: {
					"x-vlyv-origin-token": {
						operation: "set",
						value: config.originTokenHash,
					},
				},
			},
			expression: `(http.host eq ${expressionString(host)})`,
			description: `vlyv origin protection for ${host}`,
			enabled: true,
		});
	};

	const ensureCacheRule = async (
		hostname: string,
		staticExpression?: string,
	) => {
		if (!config.cacheEnabled) return;
		const host = normalizedHostname(hostname);
		await upsertEntrypointRule("http_request_cache_settings", {
			ref: ruleRef("cache", host),
			action: "set_cache_settings",
			action_parameters: {
				cache: true,
				respect_strong_etags: true,
				cache_key: { ignore_query_strings_order: true },
				edge_ttl: {
					mode: "override_origin",
					default: config.cacheTtlSeconds,
				},
				browser_ttl: {
					mode: "override_origin",
					default: staticExpression ? 0 : config.browserTtlSeconds,
				},
			},
			expression:
				staticExpression ||
				`(http.host eq ${expressionString(host)} and http.request.method in {"GET" "HEAD"} and (http.request.uri.path.extension in {${STATIC_EXTENSIONS.map((extension) => expressionString(extension)).join(" ")}}))`,
			description: `vlyv cache policy for ${host}`,
			enabled: true,
		});
	};

	const ensureStaticDelivery = async (
		hostname: string,
		delivery?: CloudflareStaticDelivery,
	) => {
		const host = normalizedHostname(hostname);
		if (!delivery) {
			await Promise.all([
				deleteEntrypointRule(
					"http_request_transform",
					ruleRef("static-path", host),
				),
				deleteEntrypointRule(
					"http_request_origin",
					ruleRef("static-origin", host),
				),
			]);
			return undefined;
		}
		const normalized = normalizeStaticDelivery(host, delivery);
		const expression = cloudflareStaticRouteExpression(host, delivery);
		const rewrittenPath = normalized.basePath
			? `concat(${expressionString(normalized.basePath)}, http.request.uri.path)`
			: "http.request.uri.path";
		await Promise.all([
			upsertEntrypointRule("http_request_transform", {
				ref: ruleRef("static-path", host),
				action: "rewrite",
				action_parameters: {
					uri: { path: { expression: rewrittenPath } },
				},
				expression,
				description: `vlyv static object path for ${host}`,
				enabled: true,
			}),
			upsertEntrypointRule("http_request_origin", {
				ref: ruleRef("static-origin", host),
				action: "route",
				action_parameters: {
					host_header: normalized.originHostname,
					origin: { host: normalized.originHostname, port: 443 },
				},
				expression,
				description: `vlyv static object origin for ${host}`,
				enabled: true,
			}),
		]);
		return expression;
	};

	const configureHostnameRouting = async (
		hostname: string,
		options: { staticDelivery?: CloudflareStaticDelivery } = {},
	) => {
		const host = normalizedHostname(hostname);
		const staticExpression = await ensureStaticDelivery(
			host,
			options.staticDelivery,
		);
		await Promise.all([
			ensureOriginProtection(host),
			ensureCacheRule(host, staticExpression),
		]);
		await request(`/zones/${encodeURIComponent(config.zoneId)}/purge_cache`, {
			method: "POST",
			body: { hosts: [host] },
		});
	};

	const deleteHostnameRouting = async (hostname: string) => {
		const host = normalizedHostname(hostname);
		await Promise.all([
			deleteEntrypointRule(
				"http_request_late_transform",
				ruleRef("origin", host),
			),
			deleteEntrypointRule(
				"http_request_cache_settings",
				ruleRef("cache", host),
			),
			deleteEntrypointRule(
				"http_request_transform",
				ruleRef("static-path", host),
			),
			deleteEntrypointRule(
				"http_request_origin",
				ruleRef("static-origin", host),
			),
		]);
	};

	return {
		configureHostnameRouting,
		deleteHostnameRouting,
		verifyCdnHostname: async (hostname: string) => {
			const host = normalizedHostname(hostname);
			if (isHostnameInCloudflareZone(host, config.zoneName)) {
				const records = await list<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/dns_records?name=${encodeURIComponent(host)}`,
				);
				if (!records.some((record) => record.proxied === true)) {
					throw new Error(
						"Static object-storage hostname must be proxied by Cloudflare",
					);
				}
				return true;
			}
			const custom = (
				await list<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames?hostname=${encodeURIComponent(host)}`,
				)
			)[0];
			if (custom?.status !== "active" || custom.ssl?.status !== "active") {
				throw new Error(
					"Static object-storage custom hostname is not active on Cloudflare",
				);
			}
			return true;
		},
		verify: async () => {
			const token = await request<{ status?: string }>("/user/tokens/verify");
			if (token?.status !== "active") {
				throw new Error("Cloudflare API token is not active");
			}
			const zone = await request<CloudflareResource>(
				`/zones/${encodeURIComponent(config.zoneId)}`,
			);
			if (
				zone?.status !== "active" ||
				zone.name?.toLowerCase() !== config.zoneName.toLowerCase() ||
				zone.account?.id !== config.accountId
			) {
				throw new Error("Cloudflare zone does not match the active provider");
			}
			if (isHostnameInCloudflareZone(config.originHostname, config.zoneName)) {
				const originRecords = await list<CloudflareResource>(
					`/zones/${encodeURIComponent(config.zoneId)}/dns_records?name=${encodeURIComponent(config.originHostname)}`,
				);
				if (
					originRecords.length === 0 ||
					originRecords.some((record) => record.proxied !== false)
				) {
					throw new Error(
						"Cloudflare origin hostname must resolve through DNS-only records",
					);
				}
			}
			return true;
		},
		configureZoneSecurity: async () => {
			await ensureManagedWildcard();
			if (config.authenticatedOriginPullsEnabled) {
				await request(
					`/zones/${encodeURIComponent(config.zoneId)}/origin_tls_client_auth/settings`,
					{ method: "PUT", body: { enabled: true } },
				);
			}
			for (const [setting, value] of [
				["ssl", "strict"],
				["always_use_https", "on"],
				["automatic_https_rewrites", "on"],
				["min_tls_version", "1.2"],
				["brotli", "on"],
				["http3", "on"],
			] as const) {
				await request(
					`/zones/${encodeURIComponent(config.zoneId)}/settings/${setting}`,
					{ method: "PATCH", body: { value } },
				);
			}
			if (config.managedWafEnabled) {
				const managedRulesets = await list<CloudflareRuleset>(
					`/zones/${encodeURIComponent(config.zoneId)}/rulesets?phase=http_request_firewall_managed`,
				);
				const managed = managedRulesets.find(
					(ruleset) =>
						ruleset.kind === "managed" && /ruleset/i.test(ruleset.name || ""),
				);
				if (!managed) {
					throw new Error("Cloudflare managed WAF rules are unavailable");
				}
				await upsertEntrypointRule("http_request_firewall_managed", {
					ref: "vlyv-managed-waf",
					action: "execute",
					action_parameters: { id: managed.id },
					expression: "true",
					description: "vlyv Cloudflare managed WAF",
					enabled: true,
				});
			}
		},
		publishHostname: async (
			hostname: string,
			options: {
				expectedResourceId?: string | null;
				staticDelivery?: CloudflareStaticDelivery;
			} = {},
		) => {
			const host = normalizedHostname(hostname);
			if (
				host === normalizedHostname(config.originHostname, "origin hostname")
			) {
				throw new Error(
					"Cloudflare origin hostname cannot be published at the edge",
				);
			}
			let publication: { resource: CloudflareResource; created: boolean };
			let kind: "dns" | "custom_hostname" | "load_balancer";
			if (!isHostnameInCloudflareZone(host, config.zoneName)) {
				publication = await ensureCustomHostname(
					host,
					options.expectedResourceId,
				);
				kind = "custom_hostname";
			} else if (config.geoRoutingEnabled) {
				publication = await ensureLoadBalancer(host);
				kind = "load_balancer";
			} else {
				publication = await ensureDnsRecord(host);
				kind = "dns";
			}
			try {
				await configureHostnameRouting(host, options);
			} catch (error) {
				if (publication.created) {
					const segment =
						kind === "dns"
							? "dns_records"
							: kind === "custom_hostname"
								? "custom_hostnames"
								: "load_balancers";
					await Promise.allSettled([
						request(
							`/zones/${encodeURIComponent(config.zoneId)}/${segment}/${encodeURIComponent(publication.resource.id)}`,
							{ method: "DELETE", allowNotFound: true },
						),
						deleteHostnameRouting(host),
					]);
				}
				throw error;
			}
			return { ...publication, kind };
		},
		deleteHostname: async ({
			hostname,
			kind,
			resourceId,
		}: {
			hostname: string;
			kind: "dns" | "custom_hostname" | "load_balancer";
			resourceId: string;
		}) => {
			const host = normalizedHostname(hostname);
			const segment =
				kind === "dns"
					? "dns_records"
					: kind === "custom_hostname"
						? "custom_hostnames"
						: "load_balancers";
			await request(
				`/zones/${encodeURIComponent(config.zoneId)}/${segment}/${encodeURIComponent(resourceId)}`,
				{ method: "DELETE", allowNotFound: true },
			);
			await deleteHostnameRouting(host);
		},
		getUsage: async ({
			hostname,
			from,
			to,
		}: {
			hostname: string;
			from: Date;
			to: Date;
		}): Promise<CloudflareUsage> => {
			if (!config.analyticsEnabled) return { requests: 0n, egressBytes: 0n };
			const host = normalizedHostname(hostname);
			const response = await fetcher(`${apiBase}/graphql`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					query: `query VlyvEdgeUsage($zoneTag: string!, $host: string!, $from: Time!, $to: Time!) {
  viewer { zones(filter: { zoneTag: $zoneTag }) {
    httpRequestsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost: $host }) {
      count
      sum { edgeResponseBytes }
    }
  } }
}`,
					variables: {
						zoneTag: config.zoneId,
						host,
						from: from.toISOString(),
						to: to.toISOString(),
					},
				}),
				signal: AbortSignal.timeout(30_000),
			});
			const payload = (await response.json().catch(() => null)) as {
				data?: {
					viewer?: {
						zones?: Array<{
							httpRequestsAdaptiveGroups?: Array<{
								count?: number;
								sum?: { edgeResponseBytes?: number };
							}>;
						}>;
					};
				};
				errors?: unknown[];
			} | null;
			if (!response.ok || !payload?.data || payload.errors?.length) {
				throw new Error("Cloudflare analytics request failed");
			}
			const groups =
				payload.data.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
			return groups.reduce<CloudflareUsage>(
				(total, group) => ({
					requests:
						total.requests +
						exactAnalyticsInteger(group.count ?? 0, "request count"),
					egressBytes:
						total.egressBytes +
						exactAnalyticsInteger(
							group.sum?.edgeResponseBytes ?? 0,
							"egress bytes",
						),
				}),
				{ requests: 0n, egressBytes: 0n },
			);
		},
	};
};

export type CloudflareEdgeClient = ReturnType<
	typeof createCloudflareEdgeClient
>;
