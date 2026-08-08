import {
	createNeonManagedDataProvider,
	decodeNeonProjectRef,
} from "@dokploy/server/services/managed-data-providers/neon";
import { describe, expect, it, vi } from "vitest";

const request = (overrides: Record<string, unknown> = {}) => ({
	managedDataResourceId: "managed-data-1",
	idempotencyKey: "neon-provision-1",
	organizationId: "organization-1",
	projectId: "project-1",
	environmentId: "environment-1",
	regionId: "region-1",
	providerRegion: "aws-us-east-1",
	kind: "postgres" as const,
	name: "primary",
	plan: "pro" as const,
	providerPlan: "launch",
	storageLimitBytes: 10n * 1024n ** 3n,
	retentionDays: 7,
	pitrEnabled: true,
	highAvailability: true,
	poolingEnabled: true,
	replicas: 2,
	backupEnabled: true,
	backupIntervalHours: 24,
	backupRetentionDays: 7,
	...overrides,
});

const response = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});

describe("Neon managed Postgres provider", () => {
	it("provisions pooled, PITR-enabled Postgres with encrypted provider metadata", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			calls.push({ url: String(input), init });
			if (String(input).includes("projects?")) {
				return response({ projects: [] });
			}
			return response(
				{
					project: {
						id: "project-neon-1",
						name: "primary",
						region_id: "aws-us-east-1",
						history_retention_seconds: 604800,
						updated_at: "2026-08-05T00:00:00.000Z",
					},
					branch: { id: "br-main-1" },
					roles: [{ name: "app_owner", password: "secret" }],
					databases: [{ name: "app" }],
					connection_uris: [
						{
							connection_uri:
								"postgres://app_owner:secret@ep.neon.tech/app?sslmode=require",
						},
					],
					operations: [{ status: "finished" }],
				},
				201,
			);
		});
		const provider = createNeonManagedDataProvider({
			apiKey: "neon-api-key",
			organizationId: "org-neon",
			fetcher,
			validateEndpoint: async () => undefined,
		});

		const provisioned = await provider.provision(request());

		expect(provisioned.status).toBe("ready");
		expect(provisioned.connectionUri).toContain("sslmode=require");
		expect(decodeNeonProjectRef(provisioned.providerResourceId)).toEqual({
			projectId: "project-neon-1",
			branchId: "br-main-1",
			roleName: "app_owner",
			databaseName: "app",
			operationIds: [],
		});
		const createCall = calls.find((call) => call.init?.method === "POST");
		const body = JSON.parse(String(createCall?.init?.body));
		expect(body.project).toMatchObject({
			region_id: "aws-us-east-1",
			pg_version: 17,
			history_retention_seconds: 604800,
			org_id: "org-neon",
			branch: { database_name: "app", role_name: "app_owner" },
		});
		expect(body.project.name).toMatch(/^vlyv-[a-f0-9]{24}$/);
		expect(createCall?.init?.headers).not.toHaveProperty("Idempotency-Key");
	});

	it("reads exact storage usage and creates encrypted snapshots", async () => {
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/projects/project-neon-1")) {
				return response({
					project: {
						id: "project-neon-1",
						name: "primary",
						region_id: "aws-us-east-1",
						history_retention_seconds: 604800,
						synthetic_storage_size: 123456789,
						updated_at: "2026-08-05T00:00:00.000Z",
					},
				});
			}
			if (url.endsWith("/projects/project-neon-1/snapshots")) {
				return response({ snapshots: [] });
			}
			if (url.includes("/snapshot?") && init?.method === "POST") {
				return response({
					snapshot: {
						id: "snapshot-1",
						name: "daily",
						created_at: "2026-08-05T12:00:00.000Z",
						expires_at: "2026-08-12T12:00:00.000Z",
						full_size: 123456789,
					},
					operations: [{ status: "finished" }],
				});
			}
			throw new Error(`Unexpected Neon call ${init?.method} ${url}`);
		});
		const provider = createNeonManagedDataProvider({
			apiKey: "neon-api-key",
			fetcher,
			validateEndpoint: async () => undefined,
		});
		const resourceId = `neon.${Buffer.from(
			JSON.stringify({
				projectId: "project-neon-1",
				branchId: "br-main-1",
				roleName: "app_owner",
				databaseName: "app",
			}),
		).toString("base64url")}`;

		await expect(provider.getUsage(resourceId)).resolves.toMatchObject({
			consumedBytes: 123456789n,
		});
		await expect(
			provider.createBackup(resourceId, {
				idempotencyKey: "backup-1",
				name: "daily",
				expiresAt: new Date("2026-08-12T12:00:00.000Z"),
			}),
		).resolves.toMatchObject({
			backupId: "snapshot-1",
			status: "ready",
			sizeBytes: 123456789n,
			encryption: "provider_kms",
		});
	});

	it("persists the new branch identity returned by a terminal restore", async () => {
		let restoreAttempts = 0;
		const sleep = vi.fn(async () => undefined);
		const fetcher = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/snapshots/snapshot-1/restore")) {
				restoreAttempts += 1;
				if (restoreAttempts === 1) {
					return response({ detail: "Project operation is locked" }, 423);
				}
				return response({
					branch: { id: "br-restored-1", name: "restored" },
					operations: [{ status: "finished" }],
				});
			}
			if (url.includes("/connection_uri?")) {
				return response({
					uri: "postgres://app_owner:secret@restored.neon.tech/app?sslmode=require",
				});
			}
			throw new Error(`Unexpected Neon call ${init?.method} ${url}`);
		});
		const provider = createNeonManagedDataProvider({
			apiKey: "neon-api-key",
			fetcher,
			validateEndpoint: async () => undefined,
			pollIntervalMs: 1,
			sleep,
		});
		const resourceId = `neon.${Buffer.from(
			JSON.stringify({
				projectId: "project-neon-1",
				branchId: "br-main-1",
				roleName: "app_owner",
				databaseName: "app",
			}),
		).toString("base64url")}`;

		const restored = await provider.restoreBackup(resourceId, "snapshot-1");

		expect(decodeNeonProjectRef(restored.providerResourceId)).toMatchObject({
			projectId: "project-neon-1",
			branchId: "br-restored-1",
		});
		expect(restored.connectionUri).toContain("restored.neon.tech");
		expect(restoreAttempts).toBe(2);
		expect(sleep).toHaveBeenCalledOnce();
	});
});
