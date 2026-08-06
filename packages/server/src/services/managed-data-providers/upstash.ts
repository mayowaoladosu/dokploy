import { createHash } from "node:crypto";
import { z } from "zod";
import type {
	ManagedDataProvider,
	ManagedDataProviderBackup,
	ManagedDataProvisionRequest,
} from "../managed-data-provider";
import { assertPublicHealthEndpoint } from "../runtime-scheduler";

const UPSTASH_API_BASE = "https://api.upstash.com/v2/redis";
const databaseSchema = z
	.object({
		database_id: z.string().min(1),
		database_name: z.string(),
		state: z.enum(["active", "suspended", "passive"]),
		endpoint: z.string().min(1),
		port: z.number().int().min(1).max(65_535),
		password: z.string().min(1),
		tls: z.boolean(),
		primary_region: z.string().optional(),
		all_members: z.array(z.string()).optional(),
		type: z.string().optional(),
		db_disk_threshold: z.number().int().nonnegative().optional(),
		modifying_state: z.string().optional(),
		prod_pack_enabled: z.boolean().optional(),
		securityAddons: z
			.object({ encryptionAtRest: z.boolean().optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();
const pointSchema = z.object({
	x: z.string(),
	y: z.number().nonnegative(),
});
const statsSchema = z
	.object({
		diskusage: z.array(pointSchema).default([]),
		current_storage: z.number().nonnegative().optional(),
	})
	.passthrough();
const backupSchema = z
	.object({
		backup_id: z.string().min(1),
		name: z.string(),
		creation_time: z.number().int().nonnegative(),
		state: z.enum(["pending", "completed", "failed"]),
		backup_size: z.number().int().nonnegative(),
	})
	.passthrough();

const databaseHost = (endpoint: string) =>
	endpoint.includes(".") ? endpoint : `${endpoint}.upstash.io`;

const databaseNameFor = (managedDataResourceId: string) =>
	`vlyv-${createHash("sha256")
		.update(managedDataResourceId)
		.digest("hex")
		.slice(0, 24)}`;

const assertEncryptedDatabase = (database: z.infer<typeof databaseSchema>) => {
	if (!database.tls) throw new Error("Upstash database did not enable TLS");
	if (
		database.prod_pack_enabled !== true &&
		database.securityAddons?.encryptionAtRest !== true
	) {
		throw new Error("Upstash database did not attest encryption at rest");
	}
	return database;
};

const assertDatabaseCapacity = (
	database: z.infer<typeof databaseSchema>,
	storageLimitBytes: bigint,
) => {
	if (
		database.db_disk_threshold !== undefined &&
		BigInt(database.db_disk_threshold) < storageLimitBytes
	) {
		throw new Error(
			"Upstash database capacity is below the platform plan allowance",
		);
	}
};

const connectionUri = (database: z.infer<typeof databaseSchema>) => {
	const uri = new URL(
		`${database.tls ? "rediss" : "redis"}://default@${databaseHost(database.endpoint)}:${database.port}`,
	);
	uri.password = database.password;
	return uri.toString();
};

const providerBackup = (
	backup: z.infer<typeof backupSchema>,
): ManagedDataProviderBackup => ({
	backupId: backup.backup_id,
	status:
		backup.state === "completed"
			? "ready"
			: backup.state === "failed"
				? "failed"
				: "pending",
	createdAt: new Date(backup.creation_time * 1_000),
	sizeBytes: BigInt(backup.backup_size),
	encryption: "provider_kms",
	metadata: { provider: "upstash", backupName: backup.name },
});

export const createUpstashManagedDataProvider = ({
	name = "upstash",
	email,
	apiKey,
	apiBase = UPSTASH_API_BASE,
	productionPackEnabled,
	fetcher = fetch,
	validateEndpoint = assertPublicHealthEndpoint,
	pollIntervalMs = 2_000,
	operationTimeoutMs = 10 * 60_000,
	sleep = (durationMs: number) =>
		new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
}: {
	name?: string;
	email: string;
	apiKey: string;
	apiBase?: string;
	productionPackEnabled: boolean;
	fetcher?: typeof fetch;
	validateEndpoint?: (endpoint: string) => Promise<void>;
	pollIntervalMs?: number;
	operationTimeoutMs?: number;
	sleep?: (durationMs: number) => Promise<void>;
}): ManagedDataProvider => {
	if (!email.trim() || !apiKey.trim()) {
		throw new Error("Upstash email and API key are required");
	}
	const base = new URL(apiBase);
	if (base.protocol !== "https:" || base.username || base.password) {
		throw new Error("Upstash API endpoint must use clean HTTPS");
	}
	const authorization = `Basic ${Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64")}`;
	const request = async <T>(
		path: string,
		init: RequestInit,
		schema: z.ZodType<T>,
		allowNotFound = false,
	) => {
		await validateEndpoint(base.toString());
		const response = await fetcher(
			new URL(path, `${base.toString().replace(/\/$/, "")}/`),
			{
				...init,
				headers: {
					Accept: "application/json",
					Authorization: authorization,
					"Content-Type": "application/json",
					...init.headers,
				},
				redirect: "error",
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (allowNotFound && response.status === 404) return undefined as T;
		if (!response.ok) {
			throw new Error(`Upstash API returned HTTP ${response.status}`);
		}
		const text = await response.text();
		if (!text) return schema.parse({});
		try {
			return schema.parse(JSON.parse(text));
		} catch {
			return schema.parse(text);
		}
	};
	const getDatabase = (providerResourceId: string) =>
		request(
			`database/${encodeURIComponent(providerResourceId)}`,
			{ method: "GET" },
			databaseSchema,
		);
	const listDatabases = () =>
		request(
			"databases",
			{ method: "GET" },
			z.array(databaseSchema),
		);
	const listBackups = (providerResourceId: string) =>
		request(
			`list-backup/${encodeURIComponent(providerResourceId)}`,
			{ method: "GET" },
			z.array(backupSchema),
		);
	const waitForReadyDatabase = async (providerResourceId: string) => {
		const deadline = Date.now() + operationTimeoutMs;
		while (Date.now() < deadline) {
			const database = await getDatabase(providerResourceId);
			if (database.state !== "active") {
				throw new Error(`Upstash database is ${database.state}`);
			}
			if (database.state === "active" && !database.modifying_state) {
				return database;
			}
			await sleep(pollIntervalMs);
		}
		throw new Error("Upstash database operation timed out");
	};
	return {
		name,
		kinds: new Set(["redis"]),
		capabilities: {
			highAvailability: true,
			pooling: true,
			pitr: false,
			backups: true,
			restore: true,
			credentialRotation: true,
			usage: true,
			encryptionAtRest: productionPackEnabled,
			platformArchive: false,
		},
		verify: async () => {
			await listDatabases();
			return true;
		},
		provision: async (input: ManagedDataProvisionRequest) => {
			if (input.kind !== "redis")
				throw new Error("Upstash supports Redis only");
			const providerRegion = z
				.string()
				.min(1)
				.parse(input.providerRegion);
			const databaseName = databaseNameFor(input.managedDataResourceId);
			const existing = (await listDatabases()).find(
				(database) => database.database_name === databaseName,
			);
			if (existing) {
				assertEncryptedDatabase(existing);
				assertDatabaseCapacity(existing, input.storageLimitBytes);
				return {
					providerResourceId: existing.database_id,
					status:
						existing.state === "active" && !existing.modifying_state
							? ("ready" as const)
							: ("provisioning" as const),
					connectionUri: connectionUri(existing),
					metadata: { provider: "upstash", adopted: true },
				};
			}
			const database = await request(
				"database",
				{
					method: "POST",
					body: JSON.stringify({
						database_name: databaseName,
						platform: "aws",
						primary_region: providerRegion,
						read_regions: [],
						plan: input.providerPlan,
						eviction: false,
						tls: true,
					}),
				},
				databaseSchema,
			);
			try {
				await request(
					`${encodeURIComponent(database.database_id)}/change-plan`,
					{
						method: "POST",
						body: JSON.stringify({
							plan_name: input.providerPlan,
							auto_upgrade: true,
							prod_pack_enabled: true,
						}),
					},
					z.string(),
				);
				const ready = await waitForReadyDatabase(database.database_id);
				assertEncryptedDatabase(ready);
				assertDatabaseCapacity(ready, input.storageLimitBytes);
				Object.assign(database, ready);
			} catch (error) {
				await request(
					`database/${encodeURIComponent(database.database_id)}`,
					{ method: "DELETE" },
					z.string(),
					true,
				).catch(() => undefined);
				throw error;
			}
			return {
				providerResourceId: database.database_id,
				status:
					database.state === "active" && !database.modifying_state
						? ("ready" as const)
						: ("provisioning" as const),
				connectionUri: connectionUri(database),
				metadata: {
					provider: "upstash",
					region: database.primary_region,
					readRegions: database.all_members,
					highAvailability: input.highAvailability,
					encryptionAtRest: productionPackEnabled
						? "provider_kms"
						: "unavailable",
				},
			};
		},
		getStatus: async (providerResourceId) => {
			const database = assertEncryptedDatabase(
				await getDatabase(providerResourceId),
			);
			if (database.state !== "active") {
				throw new Error(`Upstash database is ${database.state}`);
			}
			return {
				providerResourceId,
				status:
					database.state === "active" && !database.modifying_state
						? ("ready" as const)
						: ("provisioning" as const),
				connectionUri: connectionUri(database),
				metadata: { provider: "upstash", state: database.state },
			};
		},
		getUsage: async (providerResourceId) => {
			const stats = await request(
				`stats/${encodeURIComponent(providerResourceId)}`,
				{ method: "GET" },
				statsSchema,
			);
			const latest = [...stats.diskusage]
				.sort((left, right) => left.x.localeCompare(right.x))
				.at(-1);
			if (stats.current_storage === undefined && !latest) {
				throw new Error("Upstash did not return current storage usage");
			}
			return {
				consumedBytes: BigInt(
					Math.max(Math.ceil(stats.current_storage ?? latest?.y ?? 0), 0),
				),
				observedAt:
					latest && Number.isFinite(new Date(latest.x).getTime())
						? new Date(latest.x)
						: new Date(),
			};
		},
		rotateCredentials: async (providerResourceId) => {
			const database = await request(
				`reset-password/${encodeURIComponent(providerResourceId)}`,
				{ method: "POST" },
				databaseSchema,
			);
			return { connectionUri: connectionUri(database) };
		},
		createBackup: async (providerResourceId, input) => {
			const existing = (await listBackups(providerResourceId)).find(
				(entry) => entry.name === input.name,
			);
			if (existing) {
				return { ...providerBackup(existing), expiresAt: input.expiresAt };
			}
			await request(
				`create-backup/${encodeURIComponent(providerResourceId)}`,
				{
					method: "POST",
					body: JSON.stringify({ name: input.name }),
				},
				z.string(),
			);
			const deadline = Date.now() + operationTimeoutMs;
			while (Date.now() < deadline) {
				const backup = (await listBackups(providerResourceId)).find(
					(entry) => entry.name === input.name,
				);
				if (backup) {
					return { ...providerBackup(backup), expiresAt: input.expiresAt };
				}
				await sleep(pollIntervalMs);
			}
			throw new Error("Upstash backup did not return an authoritative identity");
		},
		getBackup: async (providerResourceId, backupId) => {
			const backup = (await listBackups(providerResourceId)).find(
				(entry) => entry.backup_id === backupId || entry.name === backupId,
			);
			if (!backup) throw new Error("Upstash backup was not found");
			return providerBackup(backup);
		},
		restoreBackup: async (providerResourceId, backupId) => {
			await request(
				`restore-backup/${encodeURIComponent(providerResourceId)}`,
				{
					method: "POST",
					body: JSON.stringify({ backup_id: backupId }),
				},
				z.string(),
			);
			const database = assertEncryptedDatabase(
				await waitForReadyDatabase(providerResourceId),
			);
			return {
				providerResourceId,
				connectionUri: connectionUri(database),
			};
		},
		deleteBackup: async (providerResourceId, backupId) => {
			await request(
				`delete-backup/${encodeURIComponent(providerResourceId)}/${encodeURIComponent(backupId)}`,
				{ method: "DELETE" },
				z.string(),
				true,
			);
		},
		delete: async (providerResourceId) => {
			await request(
				`database/${encodeURIComponent(providerResourceId)}`,
				{ method: "DELETE" },
				z.string(),
				true,
			);
		},
	};
};
