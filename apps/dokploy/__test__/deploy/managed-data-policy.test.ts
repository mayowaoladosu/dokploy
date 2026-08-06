import type { ManagedDataResource } from "@dokploy/server/db/schema";
import {
	clearManagedDataProviders,
	createHttpManagedDataProvider,
	listManagedDataServiceCatalog,
	managedDataPlanPolicy,
	managedDataResourceForTenant,
	registerManagedDataProvider,
} from "@dokploy/server/services/managed-data-provider";
import { assertLegacyDatabaseAllowed } from "@dokploy/server/services/platform";
import { afterEach, describe, expect, it } from "vitest";

const provider = (name: string) =>
	createHttpManagedDataProvider({
		name,
		baseUrl: "https://data.example.com",
		token: "provider-token",
		kinds: ["postgres"],
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
		validateEndpoint: async () => undefined,
	});

describe("managed data platform policy", () => {
	afterEach(() => clearManagedDataProviders());

	it("exposes only platform products, never provider identities or mappings", () => {
		registerManagedDataProvider(
			provider("installation-secret-id"),
			["postgres"],
			{
				planMappings: {
					starter: "vendor-launch",
					pro: "vendor-scale",
					scale: "vendor-business",
				},
				regionMappings: { "us-east": "aws-us-east-1" },
			},
		);

		expect(listManagedDataServiceCatalog()).toEqual([
			expect.objectContaining({
				kind: "postgres",
				plans: ["starter", "pro", "scale"],
			}),
		]);
		expect(JSON.stringify(listManagedDataServiceCatalog())).not.toContain(
			"installation-secret-id",
		);
		expect(JSON.stringify(listManagedDataServiceCatalog())).not.toContain(
			"vendor-",
		);
	});

	it("rejects ambiguous default providers", () => {
		registerManagedDataProvider(provider("first"), ["postgres"]);
		expect(() =>
			registerManagedDataProvider(provider("second"), ["postgres"]),
		).toThrow("More than one default managed postgres provider");
	});

	it("fails closed when a generic provider omits capability attestations", () => {
		const unverified = createHttpManagedDataProvider({
			name: "unverified",
			baseUrl: "https://data.example.com",
			token: "provider-token",
			kinds: ["postgres"],
			validateEndpoint: async () => undefined,
		});
		expect(() => registerManagedDataProvider(unverified, ["postgres"])).toThrow(
			"without usage, backups, and encrypted storage",
		);
	});

	it("applies bounded platform-owned plan policy", () => {
		expect(managedDataPlanPolicy.starter).toMatchObject({
			storageLimitBytes: 1024n ** 3n,
			backupRetentionDays: 7,
		});
		expect(managedDataPlanPolicy.scale.storageLimitBytes).toBe(
			100n * 1024n ** 3n,
		);
	});

	it("returns a strict tenant DTO without provider or credential metadata", () => {
		const resource = {
			managedDataResourceId: "resource-1",
			idempotencyKey: "secret-idempotency",
			requestHash: "sha256:secret",
			organizationId: "organization-secret",
			projectId: "project-1",
			environmentId: "environment-1",
			regionId: "region-1",
			provider: "provider-installation-secret",
			providerResourceId: "provider-resource-secret",
			kind: "postgres",
			status: "ready",
			name: "primary",
			plan: "pro",
			storageLimitBytes: 1024n,
			retentionDays: 7,
			pitrEnabled: true,
			highAvailability: true,
			poolingEnabled: true,
			replicas: 2,
			backupEnabled: true,
			backupIntervalHours: 12,
			backupRetentionDays: 14,
			nextBackupAt: new Date("2026-08-06T00:00:00.000Z"),
			lastBackupAt: null,
			lifecycleAttempts: 0,
			nextReconcileAt: new Date("2026-08-05T12:00:00.000Z"),
			credentialVersion: 1,
			lastHealthyAt: new Date("2026-08-05T12:00:00.000Z"),
			deletionRequestedAt: null,
			usageAttempts: 0,
			nextUsageAt: new Date("2026-08-05T12:15:00.000Z"),
			connectionUri: "postgres://app:secret@db.example.com/app",
			errorMessage: null,
			metadata: {
				providerPlan: "vendor-scale",
				providerRegion: "aws-us-east-1",
				clusterId: "cluster-secret",
			},
			createdAt: new Date("2026-08-05T00:00:00.000Z"),
			updatedAt: new Date("2026-08-05T12:00:00.000Z"),
		} satisfies ManagedDataResource;

		const output = managedDataResourceForTenant(resource);
		const serialized = JSON.stringify(output);
		expect(output).toMatchObject({
			managedDataResourceId: "resource-1",
			storageLimitBytes: "1024",
			status: "ready",
		});
		expect(output).not.toHaveProperty("regionId");
		expect(serialized).not.toContain("provider");
		expect(serialized).not.toContain("organization-secret");
		expect(serialized).not.toContain("postgres://");
		expect(serialized).not.toContain("cluster-secret");
	});

	it("structurally denies legacy container databases in managed mode", () => {
		expect(() => assertLegacyDatabaseAllowed(true)).toThrow(
			"Container databases are development-only",
		);
		expect(() => assertLegacyDatabaseAllowed(false)).not.toThrow();
	});
});
