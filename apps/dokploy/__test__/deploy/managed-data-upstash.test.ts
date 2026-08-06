import { createUpstashManagedDataProvider } from "@dokploy/server/services/managed-data-providers/upstash";
import { describe, expect, it, vi } from "vitest";

const request = {
	managedDataResourceId: "managed-data-redis-1",
	idempotencyKey: "upstash-provision-1",
	organizationId: "organization-1",
	projectId: "project-1",
	environmentId: "environment-1",
	regionId: "region-1",
	providerRegion: "us-east-1",
	kind: "redis" as const,
	name: "cache",
	plan: "pro" as const,
	providerPlan: "payg",
	storageLimitBytes: 10n * 1024n ** 3n,
	retentionDays: 7,
	pitrEnabled: false,
	highAvailability: true,
	poolingEnabled: false,
	replicas: 2,
	backupEnabled: true,
	backupIntervalHours: 24,
	backupRetentionDays: 7,
};

const database = {
	database_id: "redis-1",
	database_name: "cache",
	state: "active",
	endpoint: "cache-redis-1.upstash.io",
	port: 6379,
	password: "secret/password",
	tls: true,
	primary_region: "us-east-1",
	all_members: ["us-east-1", "us-west-1"],
	prod_pack_enabled: true,
	securityAddons: { encryptionAtRest: true },
	db_disk_threshold: 10 * 1024 ** 3,
};

const json = (value: unknown) =>
	new Response(JSON.stringify(value), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("Upstash managed Redis provider", () => {
	it("provisions TLS global Redis with read-region failover", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			calls.push({ url: String(input), init });
			if (String(input).endsWith("/databases")) return json([]);
			if (String(input).endsWith("/redis-1/change-plan")) return json("OK");
			return json(database);
		});
		const provider = createUpstashManagedDataProvider({
			email: "operator@vlyv.dev",
			apiKey: "upstash-api-key",
			productionPackEnabled: true,
			fetcher,
			validateEndpoint: async () => undefined,
		});

		const result = await provider.provision(request);

		expect(result).toMatchObject({
			providerResourceId: "redis-1",
			status: "ready",
		});
		expect(result.connectionUri).toContain(
			"rediss://default:secret%2Fpassword@",
		);
		const createCall = calls.find((call) => call.init?.method === "POST");
		const body = JSON.parse(String(createCall?.init?.body));
		expect(body).toMatchObject({
			database_name: expect.stringMatching(/^vlyv-[a-f0-9]{24}$/),
			primary_region: "us-east-1",
			read_regions: [],
			plan: "payg",
			tls: true,
		});
		expect(
			(createCall?.init?.headers as Record<string, string>).Authorization,
		).toMatch(/^Basic /);
	});

	it("meters disk usage and snapshots backups", async () => {
		let backupLists = 0;
		const sleep = vi.fn(async () => undefined);
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/stats/redis-1")) {
				return json({
					diskusage: [
						{ x: "2026-08-05T11:00:00.000Z", y: 100 },
						{ x: "2026-08-05T12:00:00.000Z", y: 250 },
					],
				});
			}
			if (url.endsWith("/create-backup/redis-1")) {
				return json("OK");
			}
			if (url.endsWith("/list-backup/redis-1")) {
				backupLists += 1;
				if (backupLists < 4) return json([]);
				return json([
					{
						database_id: "redis-1",
						backup_id: "backup-1",
						name: "daily",
						creation_time: 1785931200,
						state: "completed",
						backup_size: 250,
					},
				]);
			}
			throw new Error(`Unexpected Upstash call ${init?.method} ${url}`);
		});
		const provider = createUpstashManagedDataProvider({
			email: "operator@vlyv.dev",
			apiKey: "upstash-api-key",
			productionPackEnabled: true,
			fetcher,
			validateEndpoint: async () => undefined,
			pollIntervalMs: 1,
			operationTimeoutMs: 1_000,
			sleep,
		});

		await expect(provider.getUsage("redis-1")).resolves.toEqual({
			consumedBytes: 250n,
			observedAt: new Date("2026-08-05T12:00:00.000Z"),
		});
		await expect(
			provider.createBackup("redis-1", {
				idempotencyKey: "backup-1",
				name: "daily",
				expiresAt: new Date("2026-08-12T12:00:00.000Z"),
			}),
		).resolves.toMatchObject({
			backupId: "backup-1",
			status: "ready",
			sizeBytes: 250n,
			encryption: "provider_kms",
		});
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("does not attest encryption without the production pack", () => {
		const provider = createUpstashManagedDataProvider({
			email: "operator@vlyv.dev",
			apiKey: "upstash-api-key",
			productionPackEnabled: false,
			validateEndpoint: async () => undefined,
		});
		expect(provider.capabilities.encryptionAtRest).toBe(false);
	});
});
