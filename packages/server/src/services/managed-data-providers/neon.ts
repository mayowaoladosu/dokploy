import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	ManagedDataProvider,
	ManagedDataProviderBackup,
	ManagedDataProviderResult,
	ManagedDataProvisionRequest,
} from "../managed-data-provider";
import { assertPublicHealthEndpoint } from "../runtime-scheduler";

const NEON_API_BASE = "https://console.neon.tech/api/v2";
const IDENTIFIER = /^[a-z0-9-]{1,60}$/;
const MAX_REQUEST_RETRIES = 8;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const neonProjectRefSchema = z.object({
	projectId: z.string().regex(IDENTIFIER),
	branchId: z.string().regex(IDENTIFIER),
	roleName: z.string().min(1).max(100),
	databaseName: z.string().min(1).max(100),
	operationIds: z.array(z.string().min(1)).max(100).optional(),
});

type NeonProjectRef = z.infer<typeof neonProjectRefSchema>;

export const encodeNeonProjectRef = (value: NeonProjectRef) =>
	`neon.${Buffer.from(JSON.stringify(neonProjectRefSchema.parse(value)), "utf8").toString("base64url")}`;

export const decodeNeonProjectRef = (value: string) => {
	if (!value.startsWith("neon."))
		throw new Error("Neon resource identity is invalid");
	try {
		return neonProjectRefSchema.parse(
			JSON.parse(Buffer.from(value.slice(5), "base64url").toString("utf8")),
		);
	} catch {
		throw new Error("Neon resource identity is invalid");
	}
};

const operationSchema = z
	.object({
		id: z.string().optional(),
		status: z.string(),
		error: z.string().optional(),
	})
	.passthrough();
const projectSchema = z
	.object({
		id: z.string().regex(IDENTIFIER),
		name: z.string(),
		region_id: z.string(),
		history_retention_seconds: z.number().int().nonnegative(),
		synthetic_storage_size: z.number().int().nonnegative().optional(),
		updated_at: z.string().datetime(),
	})
	.passthrough();
const createProjectSchema = z
	.object({
		project: projectSchema,
		branch: z.object({ id: z.string().regex(IDENTIFIER) }).passthrough(),
		roles: z.array(
			z
				.object({ name: z.string(), password: z.string().optional() })
				.passthrough(),
		),
		databases: z.array(z.object({ name: z.string() }).passthrough()),
		connection_uris: z.array(
			z.object({ connection_uri: z.string().url() }).passthrough(),
		),
		operations: z.array(operationSchema),
	})
	.passthrough();
const connectionSchema = z.object({ uri: z.string().url() });
const projectResponseSchema = z.object({ project: projectSchema });
const projectsResponseSchema = z
	.object({ projects: z.array(projectSchema) })
	.passthrough();
const branchSchema = z
	.object({
		id: z.string().regex(IDENTIFIER),
		name: z.string(),
		default: z.boolean().optional(),
	})
	.passthrough();
const roleSchema = z.object({ name: z.string() }).passthrough();
const databaseSchema = z.object({ name: z.string() }).passthrough();
const roleResetSchema = z.object({
	role: z.object({ password: z.string().min(1) }).passthrough(),
	operations: z.array(operationSchema),
});
const snapshotSchema = z
	.object({
		id: z.string().regex(IDENTIFIER),
		name: z.string(),
		created_at: z.string().datetime(),
		expires_at: z.string().datetime().nullable().optional(),
		full_size: z.number().int().nonnegative().optional(),
		diff_size: z.number().int().nonnegative().optional(),
	})
	.passthrough();

const operationsReady = (operations: Array<{ status: string }>) =>
	operations.every((operation) =>
		["finished", "completed", "succeeded"].includes(operation.status),
	);

const assertOperationsSucceeded = (
	operations: Array<{ status: string; error?: string }>,
) => {
	const failed = operations.find((operation) =>
		["failed", "error", "cancelled", "canceled", "skipped"].includes(
			operation.status.toLowerCase(),
		),
	);
	if (failed) {
		throw new Error(failed.error || "Neon operation failed");
	}
};

const projectNameFor = (managedDataResourceId: string) =>
	`vlyv-${createHash("sha256")
		.update(managedDataResourceId)
		.digest("hex")
		.slice(0, 24)}`;

const replaceUriPassword = (uri: string, password: string) => {
	const value = new URL(uri);
	value.password = password;
	return value.toString();
};

const backupFromSnapshot = (
	snapshot: z.infer<typeof snapshotSchema>,
	status: ManagedDataProviderBackup["status"] = "ready",
): ManagedDataProviderBackup => ({
	backupId: snapshot.id,
	status,
	createdAt: new Date(snapshot.created_at),
	expiresAt: snapshot.expires_at ? new Date(snapshot.expires_at) : null,
	sizeBytes:
		snapshot.full_size !== undefined
			? BigInt(snapshot.full_size)
			: snapshot.diff_size !== undefined
				? BigInt(snapshot.diff_size)
				: null,
	encryption: "provider_kms",
	metadata: { provider: "neon", snapshotName: snapshot.name },
});

export const createNeonManagedDataProvider = ({
	name = "neon",
	apiKey,
	organizationId,
	apiBase = NEON_API_BASE,
	fetcher = fetch,
	validateEndpoint = assertPublicHealthEndpoint,
	pollIntervalMs = 2_000,
	operationTimeoutMs = 10 * 60_000,
	sleep = (durationMs: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
}: {
	name?: string;
	apiKey: string;
	organizationId?: string;
	apiBase?: string;
	fetcher?: typeof fetch;
	validateEndpoint?: (endpoint: string) => Promise<void>;
	pollIntervalMs?: number;
	operationTimeoutMs?: number;
	sleep?: (durationMs: number) => Promise<void>;
}): ManagedDataProvider => {
	if (!apiKey.trim()) throw new Error("Neon API key is required");
	const base = new URL(apiBase);
	if (base.protocol !== "https:" || base.username || base.password) {
		throw new Error("Neon API endpoint must use clean HTTPS");
	}
	const retryDelayMs = (response: Response, attempt: number) => {
		const retryAfter = response.headers.get("retry-after")?.trim();
		if (retryAfter) {
			const seconds = Number(retryAfter);
			const parsed = Number.isFinite(seconds)
				? seconds * 1_000
				: Date.parse(retryAfter) - Date.now();
			if (Number.isFinite(parsed) && parsed >= 0) {
				return Math.min(Math.max(parsed, 250), 30_000);
			}
		}
		return Math.min(Math.max(pollIntervalMs * 2 ** attempt, 250), 10_000);
	};
	const canRetryResponse = (method: string, status: number) =>
		status === 423 ||
		status === 429 ||
		status === 503 ||
		(IDEMPOTENT_METHODS.has(method) && [500, 502, 504].includes(status));
	const request = async <T>(
		path: string,
		init: RequestInit,
		schema: z.ZodType<T>,
		allowNotFound = false,
	) => {
		const method = (init.method || "GET").toUpperCase();
		for (let attempt = 0; ; attempt += 1) {
			await validateEndpoint(base.toString());
			const response = await fetcher(
				new URL(path, `${base.toString().replace(/\/$/, "")}/`),
				{
					...init,
					headers: {
						Accept: "application/json",
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						...init.headers,
					},
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (allowNotFound && response.status === 404) return undefined as T;
			if (
				!response.ok &&
				attempt < MAX_REQUEST_RETRIES &&
				canRetryResponse(method, response.status)
			) {
				await response.body?.cancel().catch(() => undefined);
				await sleep(retryDelayMs(response, attempt));
				continue;
			}
			if (!response.ok) {
				throw new Error(`Neon API returned HTTP ${response.status}`);
			}
			if (response.status === 204) return schema.parse({});
			return schema.parse(await response.json());
		}
	};
	const connectionUri = async (ref: NeonProjectRef) => {
		const query = new URLSearchParams({
			branch_id: ref.branchId,
			database_name: ref.databaseName,
			role_name: ref.roleName,
			pooled: "true",
		});
		return (
			await request(
				`projects/${encodeURIComponent(ref.projectId)}/connection_uri?${query}`,
				{ method: "GET" },
				connectionSchema,
			)
		).uri;
	};
	const projectRef = async (projectId: string): Promise<NeonProjectRef> => {
		const branches = await request(
			`projects/${encodeURIComponent(projectId)}/branches`,
			{ method: "GET" },
			z.object({ branches: z.array(branchSchema) }),
		);
		const branch =
			branches.branches.find((candidate) => candidate.default) ??
			branches.branches[0];
		if (!branch) throw new Error("Neon project has no branch");
		const [branchRoles, branchDatabases] = await Promise.all([
			request(
				`projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}/roles`,
				{ method: "GET" },
				z.object({ roles: z.array(roleSchema) }),
			),
			request(
				`projects/${encodeURIComponent(projectId)}/branches/${encodeURIComponent(branch.id)}/databases`,
				{ method: "GET" },
				z.object({ databases: z.array(databaseSchema) }),
			),
		]);
		const role =
			branchRoles.roles.find((candidate) => candidate.name === "app_owner") ??
			branchRoles.roles[0];
		const database =
			branchDatabases.databases.find((candidate) => candidate.name === "app") ??
			branchDatabases.databases[0];
		if (!role || !database) {
			throw new Error("Neon project has no runtime role or database");
		}
		return {
			projectId,
			branchId: branch.id,
			roleName: role.name,
			databaseName: database.name,
		};
	};
	const findProjectByName = async (projectName: string) => {
		const query = new URLSearchParams({ search: projectName, limit: "100" });
		if (organizationId) query.set("org_id", organizationId);
		const response = await request(
			`projects?${query}`,
			{ method: "GET" },
			projectsResponseSchema,
		);
		return (
			response.projects.find((project) => project.name === projectName) ?? null
		);
	};
	const waitForOperations = async (
		projectId: string,
		operations: Array<z.infer<typeof operationSchema>>,
	) => {
		assertOperationsSucceeded(operations);
		const pending = operations.filter(
			(operation) => !operationsReady([operation]),
		);
		if (pending.some((operation) => !operation.id)) {
			throw new Error("Neon operation did not return a durable identity");
		}
		const operationIds = pending.map((operation) => operation.id!);
		const deadline = Date.now() + operationTimeoutMs;
		for (const operationId of operationIds) {
			let completed = false;
			while (Date.now() < deadline) {
				const response = await request(
					`projects/${encodeURIComponent(projectId)}/operations/${encodeURIComponent(operationId)}`,
					{ method: "GET" },
					z.object({ operation: operationSchema }),
				);
				assertOperationsSucceeded([response.operation]);
				if (operationsReady([response.operation])) {
					completed = true;
					break;
				}
				await sleep(pollIntervalMs);
			}
			if (!completed) {
				throw new Error("Neon operation did not finish before the deadline");
			}
		}
	};
	const operationsStatus = async (ref: NeonProjectRef) => {
		if (!ref.operationIds?.length) return "ready" as const;
		const operations = await Promise.all(
			ref.operationIds.map(async (operationId) => {
				const response = await request(
					`projects/${encodeURIComponent(ref.projectId)}/operations/${encodeURIComponent(operationId)}`,
					{ method: "GET" },
					z.object({ operation: operationSchema }),
				);
				return response.operation;
			}),
		);
		assertOperationsSucceeded(operations);
		return operationsReady(operations)
			? ("ready" as const)
			: ("pending" as const);
	};
	return {
		name,
		kinds: new Set(["postgres"]),
		capabilities: {
			highAvailability: true,
			pooling: true,
			pitr: true,
			backups: true,
			restore: true,
			credentialRotation: true,
			usage: true,
			encryptionAtRest: true,
			platformArchive: false,
		},
		verify: async () => {
			const query = new URLSearchParams({ limit: "1" });
			if (organizationId) query.set("org_id", organizationId);
			await request(
				`projects?${query}`,
				{ method: "GET" },
				projectsResponseSchema,
			);
			return true;
		},
		provision: async (
			input: ManagedDataProvisionRequest,
		): Promise<ManagedDataProviderResult> => {
			if (input.kind !== "postgres")
				throw new Error("Neon supports Postgres only");
			const providerRegion = z
				.string()
				.regex(/^[a-z]+-[a-z]+-[a-z]+-\d$/)
				.parse(input.providerRegion);
			const databaseName = "app";
			const roleName = "app_owner";
			const projectName = projectNameFor(input.managedDataResourceId);
			const existing = await findProjectByName(projectName);
			if (existing) {
				const ref = await projectRef(existing.id);
				return {
					providerResourceId: encodeNeonProjectRef(ref),
					status: "ready",
					connectionUri: await connectionUri(ref),
					metadata: {
						provider: "neon",
						region: existing.region_id,
						adopted: true,
					},
				};
			}
			const compute =
				input.plan === "starter"
					? { min: 0.25, max: 1 }
					: input.plan === "pro"
						? { min: 0.5, max: 4 }
						: { min: 1, max: 8 };
			const created = await request(
				"projects",
				{
					method: "POST",
					body: JSON.stringify({
						project: {
							name: projectName,
							region_id: providerRegion,
							pg_version: 17,
							store_passwords: true,
							history_retention_seconds: input.pitrEnabled
								? input.retentionDays * 86_400
								: 0,
							...(organizationId ? { org_id: organizationId } : {}),
							branch: {
								name: "main",
								database_name: databaseName,
								role_name: roleName,
							},
							default_endpoint_settings: {
								autoscaling_limit_min_cu: compute.min,
								autoscaling_limit_max_cu: compute.max,
							},
						},
					}),
				},
				createProjectSchema,
			);
			assertOperationsSucceeded(created.operations);
			const role = created.roles[0];
			const database = created.databases[0];
			const uri = created.connection_uris[0]?.connection_uri;
			if (!role || !database || !uri) {
				throw new Error("Neon project did not return initial credentials");
			}
			const pendingOperationIds = created.operations
				.filter((operation) => !operationsReady([operation]))
				.map((operation) => operation.id);
			if (pendingOperationIds.some((id) => !id)) {
				throw new Error(
					"Neon project did not return durable operation identities",
				);
			}
			return {
				providerResourceId: encodeNeonProjectRef({
					projectId: created.project.id,
					branchId: created.branch.id,
					roleName: role.name,
					databaseName: database.name,
					operationIds: pendingOperationIds.filter((id): id is string =>
						Boolean(id),
					),
				}),
				status: operationsReady(created.operations) ? "ready" : "provisioning",
				connectionUri: uri,
				metadata: {
					provider: "neon",
					region: created.project.region_id,
					pooling: true,
					pitr: input.pitrEnabled,
					highAvailability: true,
					encryptionAtRest: "provider_kms",
				},
			};
		},
		getStatus: async (providerResourceId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			if ((await operationsStatus(ref)) !== "ready") {
				return { providerResourceId, status: "provisioning" as const };
			}
			const response = await request(
				`projects/${encodeURIComponent(ref.projectId)}`,
				{ method: "GET" },
				projectResponseSchema,
			);
			return {
				providerResourceId,
				status: "ready" as const,
				connectionUri: await connectionUri(ref),
				metadata: {
					provider: "neon",
					region: response.project.region_id,
					retentionDays: Math.floor(
						response.project.history_retention_seconds / 86_400,
					),
				},
			};
		},
		getUsage: async (providerResourceId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			const response = await request(
				`projects/${encodeURIComponent(ref.projectId)}`,
				{ method: "GET" },
				projectResponseSchema,
			);
			if (response.project.synthetic_storage_size === undefined) {
				throw new Error("Neon did not return current storage usage");
			}
			return {
				consumedBytes: BigInt(response.project.synthetic_storage_size),
				observedAt: new Date(),
			};
		},
		rotateCredentials: async (providerResourceId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			const reset = await request(
				`projects/${encodeURIComponent(ref.projectId)}/branches/${encodeURIComponent(ref.branchId)}/roles/${encodeURIComponent(ref.roleName)}/reset_password`,
				{ method: "POST" },
				roleResetSchema,
			);
			await waitForOperations(ref.projectId, reset.operations);
			const uri = await connectionUri(ref);
			return { connectionUri: replaceUriPassword(uri, reset.role.password) };
		},
		createBackup: async (providerResourceId, input) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			const snapshots = await request(
				`projects/${encodeURIComponent(ref.projectId)}/snapshots`,
				{ method: "GET" },
				z.object({ snapshots: z.array(snapshotSchema) }),
			);
			const existing = snapshots.snapshots.find(
				(snapshot) => snapshot.name === input.name,
			);
			if (existing) return backupFromSnapshot(existing);
			const query = new URLSearchParams({
				name: input.name,
				expires_at: input.expiresAt.toISOString(),
			});
			const response = await request(
				`projects/${encodeURIComponent(ref.projectId)}/branches/${encodeURIComponent(ref.branchId)}/snapshot?${query}`,
				{
					method: "POST",
				},
				z.object({
					snapshot: snapshotSchema,
					operations: z.array(operationSchema),
				}),
			);
			assertOperationsSucceeded(response.operations);
			await waitForOperations(ref.projectId, response.operations);
			return backupFromSnapshot(response.snapshot, "ready");
		},
		getBackup: async (providerResourceId, backupId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			const response = await request(
				`projects/${encodeURIComponent(ref.projectId)}/snapshots`,
				{ method: "GET" },
				z.object({ snapshots: z.array(snapshotSchema) }),
			);
			const snapshot = response.snapshots.find(
				(entry) => entry.id === backupId,
			);
			if (!snapshot) throw new Error("Neon snapshot was not found");
			return backupFromSnapshot(snapshot);
		},
		restoreBackup: async (providerResourceId, backupId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			const response = await request(
				`projects/${encodeURIComponent(ref.projectId)}/snapshots/${encodeURIComponent(backupId)}/restore`,
				{
					method: "POST",
					body: JSON.stringify({
						target_branch_id: ref.branchId,
						finalize_restore: true,
					}),
				},
				z
					.object({
						branch: branchSchema,
						operations: z.array(operationSchema),
					})
					.passthrough(),
			);
			await waitForOperations(ref.projectId, response.operations);
			const restoredRef = {
				...ref,
				branchId: response.branch.id,
				operationIds: [],
			};
			return {
				providerResourceId: encodeNeonProjectRef(restoredRef),
				connectionUri: await connectionUri(restoredRef),
			};
		},
		deleteBackup: async (providerResourceId, backupId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			await request(
				`projects/${encodeURIComponent(ref.projectId)}/snapshots/${encodeURIComponent(backupId)}`,
				{ method: "DELETE" },
				z.object({}).passthrough(),
				true,
			);
		},
		delete: async (providerResourceId) => {
			const ref = decodeNeonProjectRef(providerResourceId);
			await request(
				`projects/${encodeURIComponent(ref.projectId)}`,
				{ method: "DELETE" },
				z.object({}).passthrough(),
				true,
			);
		},
	};
};
