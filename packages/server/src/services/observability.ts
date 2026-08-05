import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { db } from "@dokploy/server/db";
import {
	applications,
	deployments,
	environments,
	observabilityQueryAudits,
	organizationObservabilityPolicies,
	type PlatformObservabilityBackend,
	type PlatformObservabilityBackendMetadata,
	platformObservabilityBackends,
	projects,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";

const BACKEND_KINDS = [
	"prometheus",
	"loki",
	"tempo",
	"clickhouse",
	"otlp",
] as const;
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,199}$/;
const LABEL_VALUE = /^[a-zA-Z0-9._:/-]{1,200}$/;
const TENANT_HEADER = /^[a-zA-Z0-9-]{1,100}$/;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_QUERY_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;

const isPrivateHostname = (hostname: string) => {
	const normalized = hostname.toLowerCase();
	if (normalized === "localhost" || normalized.endsWith(".localhost"))
		return true;
	const family = isIP(normalized);
	if (family === 4) {
		const [first = 0, second = 0] = normalized
			.split(".")
			.map((part) => Number.parseInt(part, 10));
		return (
			first === 10 ||
			first === 127 ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168)
		);
	}
	if (family === 6) {
		return (
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			normalized.startsWith("fe80:")
		);
	}
	return (
		!normalized.includes(".") ||
		normalized.endsWith(".svc") ||
		normalized.endsWith(".cluster.local")
	);
};

export const normalizeObservabilityEndpoint = (
	value: string,
	metadata: PlatformObservabilityBackendMetadata = {},
) => {
	const url = new URL(value);
	if (
		!(["https:", "http:"] as const).includes(
			url.protocol as "https:" | "http:",
		) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Observability backend endpoint is invalid");
	}
	if (url.protocol !== "https:" && !metadata.allowInsecure) {
		throw new Error("Observability backend endpoint must use HTTPS");
	}
	if (isPrivateHostname(url.hostname) && !metadata.allowPrivateEndpoint) {
		throw new Error(
			"Private observability endpoints require explicit operator approval",
		);
	}
	return url.toString().replace(/\/$/, "");
};

const validateBackendInput = (input: {
	kind: (typeof BACKEND_KINDS)[number];
	endpoint: string;
	tenantHeader?: string;
	tenantId?: string;
	metadata?: PlatformObservabilityBackendMetadata;
}) => {
	if (!BACKEND_KINDS.includes(input.kind)) {
		throw new Error("Observability backend kind is invalid");
	}
	if (input.tenantHeader && !TENANT_HEADER.test(input.tenantHeader)) {
		throw new Error("Observability tenant header is invalid");
	}
	if (input.tenantId && !LABEL_VALUE.test(input.tenantId)) {
		throw new Error("Observability tenant ID is invalid");
	}
	const metadata = input.metadata ?? {};
	if (metadata.retentionManagedExternally !== true) {
		throw new Error(
			"Observability backends must enforce retention externally before activation",
		);
	}
	if (
		metadata.queryTimeoutMs !== undefined &&
		(!Number.isSafeInteger(metadata.queryTimeoutMs) ||
			metadata.queryTimeoutMs < 1_000 ||
			metadata.queryTimeoutMs > 120_000)
	) {
		throw new Error("Observability query timeout is invalid");
	}
	if (
		metadata.maxResponseBytes !== undefined &&
		(!Number.isSafeInteger(metadata.maxResponseBytes) ||
			metadata.maxResponseBytes < 1_024 ||
			metadata.maxResponseBytes > 20 * 1024 * 1024)
	) {
		throw new Error("Observability response limit is invalid");
	}
	return normalizeObservabilityEndpoint(input.endpoint, metadata);
};

export const observabilityResourceId = (scope: string, value: string) =>
	createHash("sha256")
		.update(`vlyv:observability:${scope}:${value}`)
		.digest("hex")
		.slice(0, 32);

export const observabilityTenantId = (organizationId: string) =>
	observabilityResourceId("organization", organizationId);

export const redactObservabilityBackend = <
	T extends PlatformObservabilityBackend,
>(
	backend: T,
) => ({ ...backend, authToken: backend.authToken ? "********" : null });

export const createPlatformObservabilityBackend = async (input: {
	name: string;
	kind: (typeof BACKEND_KINDS)[number];
	endpoint: string;
	authToken?: string | null;
	tenantHeader?: string;
	tenantId?: string;
	isDefault?: boolean;
	metadata?: PlatformObservabilityBackendMetadata;
}) => {
	const endpoint = validateBackendInput(input);
	const backend = await db.transaction(async (tx) => {
		const [created] = await tx
			.insert(platformObservabilityBackends)
			.values({
				...input,
				endpoint,
				authToken: input.authToken?.trim() || null,
				tenantHeader: input.tenantHeader || "X-Scope-OrgID",
				tenantId: input.tenantId || "vlyv",
				status: "provisioning",
				isDefault: false,
				metadata: input.metadata ?? {},
			})
			.returning();
		if (!created) throw new Error("Failed to create observability backend");
		return created;
	});
	return redactObservabilityBackend(backend);
};

export const updatePlatformObservabilityBackend = async (
	observabilityBackendId: string,
	input: Partial<{
		name: string;
		endpoint: string;
		authToken: string | null;
		tenantHeader: string;
		tenantId: string;
		isDefault: boolean;
		status: "provisioning" | "active" | "error" | "offline";
		metadata: PlatformObservabilityBackendMetadata;
	}>,
) => {
	const current = await db.query.platformObservabilityBackends.findFirst({
		where: eq(
			platformObservabilityBackends.observabilityBackendId,
			observabilityBackendId,
		),
	});
	if (!current)
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Observability backend not found",
		});
	if (input.status === "active") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Use observability backend activation after verification",
		});
	}
	if (input.isDefault && current.status !== "active") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only a verified active backend may become the default",
		});
	}
	const metadata = input.metadata ?? current.metadata;
	const endpoint = validateBackendInput({
		kind: current.kind,
		endpoint: input.endpoint ?? current.endpoint,
		tenantHeader: input.tenantHeader ?? current.tenantHeader,
		tenantId: input.tenantId ?? current.tenantId,
		metadata,
	});
	const backend = await db.transaction(async (tx) => {
		if (input.isDefault) {
			await tx
				.update(platformObservabilityBackends)
				.set({ isDefault: false, updatedAt: new Date() })
				.where(eq(platformObservabilityBackends.kind, current.kind));
		}
		const [updated] = await tx
			.update(platformObservabilityBackends)
			.set({
				...input,
				endpoint,
				metadata,
				authToken:
					input.authToken === undefined
						? current.authToken
						: input.authToken?.trim() || null,
				updatedAt: new Date(),
			})
			.where(
				eq(
					platformObservabilityBackends.observabilityBackendId,
					observabilityBackendId,
				),
			)
			.returning();
		if (!updated) throw new Error("Failed to update observability backend");
		return updated;
	});
	return redactObservabilityBackend(backend);
};

export const activatePlatformObservabilityBackend = async (
	observabilityBackendId: string,
	makeDefault = true,
	fetcher: typeof fetch = fetch,
) => {
	const backend = await db.query.platformObservabilityBackends.findFirst({
		where: eq(
			platformObservabilityBackends.observabilityBackendId,
			observabilityBackendId,
		),
	});
	if (!backend) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Observability backend not found",
		});
	}
	let healthUrl: URL;
	if (backend.metadata.healthEndpoint) {
		healthUrl = new URL(
			normalizeObservabilityEndpoint(
				backend.metadata.healthEndpoint,
				backend.metadata,
			),
		);
	} else if (backend.kind === "prometheus") {
		healthUrl = new URL(`${backend.endpoint}/api/v1/query`);
		healthUrl.searchParams.set("query", "vector(1)");
	} else if (backend.kind === "loki" || backend.kind === "tempo") {
		healthUrl = new URL(`${backend.endpoint}/ready`);
	} else if (backend.kind === "clickhouse") {
		healthUrl = new URL(backend.endpoint);
		healthUrl.searchParams.set("query", "SELECT 1");
	} else {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "OTLP backends require a verified health endpoint",
		});
	}
	const headers: Record<string, string> = {
		Accept: "application/json, text/plain",
		[backend.tenantHeader]: backend.tenantId,
	};
	if (backend.authToken) headers.Authorization = `Bearer ${backend.authToken}`;
	try {
		const response = await fetcher(healthUrl, {
			headers,
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			throw new Error(`health probe returned ${response.status}`);
		}
		const activated = await db.transaction(async (tx) => {
			if (makeDefault) {
				await tx
					.update(platformObservabilityBackends)
					.set({ isDefault: false, updatedAt: new Date() })
					.where(eq(platformObservabilityBackends.kind, backend.kind));
			}
			const [updated] = await tx
				.update(platformObservabilityBackends)
				.set({
					status: "active",
					isDefault: makeDefault || backend.isDefault,
					updatedAt: new Date(),
				})
				.where(
					eq(
						platformObservabilityBackends.observabilityBackendId,
						observabilityBackendId,
					),
				)
				.returning();
			return updated;
		});
		if (!activated) throw new Error("Failed to activate observability backend");
		return redactObservabilityBackend(activated);
	} catch (error) {
		await db
			.update(platformObservabilityBackends)
			.set({ status: "error", updatedAt: new Date() })
			.where(
				eq(
					platformObservabilityBackends.observabilityBackendId,
					observabilityBackendId,
				),
			);
		throw new Error(
			`Observability backend verification failed: ${
				error instanceof Error ? error.message : "unknown error"
			}`,
		);
	}
};

export const listPlatformObservabilityBackends = async () =>
	(await db.query.platformObservabilityBackends.findMany()).map(
		redactObservabilityBackend,
	);

const retentionField = (kind: "metrics" | "logs" | "traces") =>
	kind === "metrics"
		? "metricsRetentionDays"
		: kind === "logs"
			? "logsRetentionDays"
			: "tracesRetentionDays";

const assertRetentionDays = (value: number) => {
	if (!Number.isSafeInteger(value) || value < 1 || value > 365) {
		throw new Error("Observability retention must be between 1 and 365 days");
	}
};

export const upsertOrganizationObservabilityPolicy = async (input: {
	organizationId: string;
	metricsRetentionDays: number;
	logsRetentionDays: number;
	tracesRetentionDays: number;
	queryEnabled?: boolean;
	metadata?: Record<string, unknown>;
}) => {
	assertRetentionDays(input.metricsRetentionDays);
	assertRetentionDays(input.logsRetentionDays);
	assertRetentionDays(input.tracesRetentionDays);
	const [policy] = await db
		.insert(organizationObservabilityPolicies)
		.values({ ...input, queryEnabled: input.queryEnabled ?? true })
		.onConflictDoUpdate({
			target: organizationObservabilityPolicies.organizationId,
			set: {
				metricsRetentionDays: input.metricsRetentionDays,
				logsRetentionDays: input.logsRetentionDays,
				tracesRetentionDays: input.tracesRetentionDays,
				queryEnabled: input.queryEnabled ?? true,
				metadata: input.metadata ?? {},
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!policy) throw new Error("Failed to persist observability policy");
	return policy;
};

export const findOrganizationObservabilityPolicy = async (
	organizationId: string,
) =>
	(await db.query.organizationObservabilityPolicies.findFirst({
		where: eq(organizationObservabilityPolicies.organizationId, organizationId),
	})) ?? {
		organizationId,
		metricsRetentionDays: 30,
		logsRetentionDays: 7,
		tracesRetentionDays: 7,
		queryEnabled: true,
		metadata: {},
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};

const escapeSelectorValue = (value: string) =>
	value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/[\r\n]/g, " ");

const optionalSelector = (name: string, value?: string) => {
	if (!value) return "";
	if (!LABEL_VALUE.test(value)) throw new Error(`${name} filter is invalid`);
	return `,${name}="${escapeSelectorValue(value)}"`;
};

export const buildScopedMetricsQuery = (input: {
	organizationId: string;
	metric: string;
	applicationId?: string;
	deploymentId?: string;
}) => {
	if (!METRIC_NAME.test(input.metric))
		throw new Error("Metric name is invalid");
	return `${input.metric}{vlyv_organization_id="${observabilityTenantId(
		input.organizationId,
	)}"${optionalSelector(
		"vlyv_application_id",
		input.applicationId
			? observabilityResourceId("application", input.applicationId)
			: undefined,
	)}${optionalSelector(
		"vlyv_deployment_id",
		input.deploymentId
			? observabilityResourceId("deployment", input.deploymentId)
			: undefined,
	)}}`;
};

export const buildScopedLogQuery = (input: {
	organizationId: string;
	search?: string;
	applicationId?: string;
	deploymentId?: string;
}) => {
	if (input.applicationId && !LABEL_VALUE.test(input.applicationId)) {
		throw new Error("application filter is invalid");
	}
	if (input.deploymentId && !LABEL_VALUE.test(input.deploymentId)) {
		throw new Error("deployment filter is invalid");
	}
	const filters = [
		`vlyv_organization_id = "${observabilityTenantId(input.organizationId)}"`,
		...(input.applicationId
			? [
					`vlyv_application_id = "${observabilityResourceId("application", input.applicationId)}"`,
				]
			: []),
		...(input.deploymentId
			? [
					`vlyv_deployment_id = "${observabilityResourceId("deployment", input.deploymentId)}"`,
				]
			: []),
	];
	const selector = `{service_name=~".+"} | ${filters.join(" | ")}`;
	if (!input.search) return selector;
	if (input.search.length > 500 || input.search.includes("\0")) {
		throw new Error("Log search is invalid");
	}
	return `${selector} |= "${escapeSelectorValue(input.search)}"`;
};

const boundedJson = async (response: Response, maxBytes: number) => {
	const declared = Number.parseInt(
		response.headers.get("content-length") || "0",
		10,
	);
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error("Observability response exceeded the size limit");
	}
	if (!response.body) throw new Error("Observability backend returned no body");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error("Observability response exceeded the size limit");
		}
		chunks.push(value);
	}
	const body = Buffer.concat(
		chunks.map((chunk) => Buffer.from(chunk)),
	).toString("utf8");
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new Error("Observability backend returned invalid JSON");
	}
};

const resultCount = (payload: unknown) => {
	if (!payload || typeof payload !== "object") return 0;
	const value = payload as {
		data?: { result?: unknown[] } | unknown[];
		traces?: unknown[];
		rows?: number;
	};
	if (Array.isArray(value.data)) return value.data.length;
	if (
		value.data &&
		!Array.isArray(value.data) &&
		Array.isArray(value.data.result)
	) {
		return value.data.result.length;
	}
	if (Array.isArray(value.traces)) return value.traces.length;
	return Number.isSafeInteger(value.rows) ? Math.max(value.rows ?? 0, 0) : 0;
};

const backendForQuery = async (kind: "metrics" | "logs" | "traces") => {
	const kinds =
		kind === "metrics"
			? (["prometheus"] as const)
			: kind === "logs"
				? (["loki", "clickhouse"] as const)
				: (["tempo"] as const);
	return (
		(await db.query.platformObservabilityBackends.findFirst({
			where: and(
				inArray(platformObservabilityBackends.kind, [...kinds]),
				eq(platformObservabilityBackends.status, "active"),
				eq(platformObservabilityBackends.isDefault, true),
			),
		})) ?? null
	);
};

const assertObservabilityResourceScope = async (input: {
	organizationId: string;
	applicationId?: string;
	deploymentId?: string;
}) => {
	if (input.applicationId) {
		const [application] = await db
			.select({ applicationId: applications.applicationId })
			.from(applications)
			.innerJoin(
				environments,
				eq(environments.environmentId, applications.environmentId),
			)
			.innerJoin(projects, eq(projects.projectId, environments.projectId))
			.where(
				and(
					eq(applications.applicationId, input.applicationId),
					eq(projects.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (!application) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Observability resource was not found",
			});
		}
	}
	if (input.deploymentId) {
		const [deployment] = await db
			.select({ deploymentId: deployments.deploymentId })
			.from(deployments)
			.innerJoin(
				applications,
				eq(applications.applicationId, deployments.applicationId),
			)
			.innerJoin(
				environments,
				eq(environments.environmentId, applications.environmentId),
			)
			.innerJoin(projects, eq(projects.projectId, environments.projectId))
			.where(
				and(
					eq(deployments.deploymentId, input.deploymentId),
					eq(projects.organizationId, input.organizationId),
					...(input.applicationId
						? [eq(applications.applicationId, input.applicationId)]
						: []),
				),
			)
			.limit(1);
		if (!deployment) {
			throw new TRPCError({
				code: "NOT_FOUND",
				message: "Observability resource was not found",
			});
		}
	}
};

export type ObservabilityQueryInput = {
	organizationId: string;
	userId?: string | null;
	kind: "metrics" | "logs" | "traces";
	start: Date;
	end: Date;
	metric?: string;
	search?: string;
	traceId?: string;
	applicationId?: string;
	deploymentId?: string;
	stepSeconds?: number;
};

const auditDeniedObservabilityQuery = async (
	input: ObservabilityQueryInput,
	error: unknown,
) => {
	const now = new Date();
	const start =
		input.start instanceof Date && Number.isFinite(input.start.getTime())
			? input.start
			: now;
	const end =
		input.end instanceof Date && Number.isFinite(input.end.getTime())
			? input.end
			: now;
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({
				kind: input.kind,
				metric: input.metric,
				applicationId: input.applicationId,
				deploymentId: input.deploymentId,
				hasSearch: Boolean(input.search),
				hasTraceId: Boolean(input.traceId),
			}),
		)
		.digest("hex");
	await db.insert(observabilityQueryAudits).values({
		organizationId: input.organizationId,
		userId: input.userId || null,
		applicationId: null,
		deploymentId: null,
		kind: input.kind,
		status: "denied",
		queryFingerprint: fingerprint,
		resultCount: 0,
		errorMessage:
			error instanceof Error
				? error.message.slice(0, 1_000)
				: "Observability query denied",
		periodStart: start,
		periodEnd: end,
		metadata: {},
	});
};

export const queryOrganizationObservability = async (
	input: ObservabilityQueryInput,
	fetcher: typeof fetch = fetch,
) => {
	try {
		await assertObservabilityResourceScope(input);
	} catch (error) {
		await auditDeniedObservabilityQuery(input, error).catch((auditError) =>
			console.error("Failed to audit denied observability query", auditError),
		);
		throw error;
	}
	const policy = await findOrganizationObservabilityPolicy(
		input.organizationId,
	);
	if (!policy.queryEnabled) {
		const error = new TRPCError({
			code: "FORBIDDEN",
			message: "Observability queries are disabled",
		});
		await auditDeniedObservabilityQuery(input, error).catch((auditError) =>
			console.error("Failed to audit denied observability query", auditError),
		);
		throw error;
	}
	if (
		!(input.start instanceof Date) ||
		!(input.end instanceof Date) ||
		input.end <= input.start
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Observability query range is invalid",
		});
	}
	const retentionDays = policy[retentionField(input.kind)];
	const retentionStart = new Date(
		Date.now() - retentionDays * 24 * 60 * 60 * 1_000,
	);
	const start = new Date(
		Math.max(input.start.getTime(), retentionStart.getTime()),
	);
	const end = new Date(Math.min(input.end.getTime(), Date.now()));
	if (end <= start || end.getTime() - start.getTime() > MAX_QUERY_RANGE_MS) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Observability query exceeds the authorized range",
		});
	}
	const backend = await backendForQuery(input.kind);
	if (!backend) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Observability backend is unavailable",
		});
	}
	const tenantId = observabilityTenantId(input.organizationId);
	const headers: Record<string, string> = {
		Accept: "application/json",
		[backend.tenantHeader]: backend.tenantId,
	};
	if (backend.authToken) headers.Authorization = `Bearer ${backend.authToken}`;
	let query = "";
	let url: URL;
	if (input.kind === "metrics") {
		query = buildScopedMetricsQuery({
			...input,
			metric: input.metric || "vlyv_release_events_total",
		});
		url = new URL(`${backend.endpoint}/api/v1/query_range`);
		url.searchParams.set("query", query);
		url.searchParams.set("start", String(start.getTime() / 1_000));
		url.searchParams.set("end", String(end.getTime() / 1_000));
		url.searchParams.set("step", String(input.stepSeconds ?? 60));
	} else if (input.kind === "logs" && backend.kind === "loki") {
		query = buildScopedLogQuery(input);
		url = new URL(`${backend.endpoint}/loki/api/v1/query_range`);
		url.searchParams.set("query", query);
		url.searchParams.set("start", String(start.getTime() * 1_000_000));
		url.searchParams.set("end", String(end.getTime() * 1_000_000));
		url.searchParams.set("limit", "1000");
	} else if (input.kind === "logs" && backend.kind === "clickhouse") {
		query =
			"SELECT timestamp, level, message, application_id, deployment_id FROM vlyv_logs WHERE organization_id = {tenant:String} AND timestamp >= {start:DateTime64} AND timestamp < {end:DateTime64} ORDER BY timestamp DESC LIMIT 1000 FORMAT JSON";
		url = new URL(backend.endpoint);
		url.searchParams.set("query", query);
		url.searchParams.set("param_tenant", tenantId);
		url.searchParams.set("param_start", start.toISOString());
		url.searchParams.set("param_end", end.toISOString());
	} else {
		if (input.traceId && !/^[a-f0-9]{16,32}$/.test(input.traceId)) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Trace ID is invalid",
			});
		}
		query = `{ span.vlyv.organization.id = "${tenantId}"${
			input.applicationId
				? ` && span.vlyv.application.id = "${observabilityResourceId("application", input.applicationId)}"`
				: ""
		}${
			input.deploymentId
				? ` && span.vlyv.deployment.id = "${observabilityResourceId("deployment", input.deploymentId)}"`
				: ""
		}${input.traceId ? ` && trace:id = "${input.traceId}"` : ""} }`;
		url = new URL(`${backend.endpoint}/api/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("start", String(Math.floor(start.getTime() / 1_000)));
		url.searchParams.set("end", String(Math.floor(end.getTime() / 1_000)));
		url.searchParams.set("limit", "1000");
	}
	const fingerprint = createHash("sha256")
		.update(`${input.kind}:${query}`)
		.digest("hex");
	let auditStatus: "succeeded" | "failed" = "failed";
	let count = 0;
	let auditError: string | null = null;
	try {
		const response = await fetcher(url, {
			headers,
			signal: AbortSignal.timeout(
				backend.metadata.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
			),
		});
		if (!response.ok)
			throw new Error(
				`Observability backend request failed (${response.status})`,
			);
		const payload = await boundedJson(
			response,
			backend.metadata.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
		);
		count = resultCount(payload);
		auditStatus = "succeeded";
		return { kind: input.kind, start, end, data: payload };
	} catch (error) {
		auditError =
			error instanceof Error
				? error.message.slice(0, 1_000)
				: "Observability query failed";
		throw error;
	} finally {
		await db.insert(observabilityQueryAudits).values({
			organizationId: input.organizationId,
			userId: input.userId || null,
			applicationId: input.applicationId || null,
			deploymentId: input.deploymentId || null,
			kind: input.kind,
			status: auditStatus,
			queryFingerprint: fingerprint,
			resultCount: count,
			errorMessage: auditError,
			periodStart: start,
			periodEnd: end,
			metadata: { backendId: backend.observabilityBackendId },
		});
	}
};

export const listOrganizationObservabilityAudits = async (
	organizationId: string,
	limit = 100,
) =>
	db.query.observabilityQueryAudits.findMany({
		where: eq(observabilityQueryAudits.organizationId, organizationId),
		orderBy: [desc(observabilityQueryAudits.createdAt)],
		limit: Math.min(Math.max(limit, 1), 500),
	});
