import type { PlatformObjectStorage } from "@dokploy/server/db/schema";
import {
	createS3ObjectStorageClient,
	createS3StaticAssetPublisher,
	normalizeStaticAssetPath,
	staticAssetObjectPrefix,
} from "@dokploy/server/services/static-object-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { persistedValues } = vi.hoisted(() => ({
	persistedValues: [] as any[],
}));

vi.mock("@dokploy/server/db", () => {
	const insertChain = {
		values: vi.fn((values: unknown) => {
			persistedValues.push(values);
			return insertChain;
		}),
		onConflictDoUpdate: vi.fn(() => insertChain),
		onConflictDoNothing: vi.fn(() => insertChain),
		returning: vi.fn(async () => [{ staticAssetPublicationId: "static-1" }]),
	};
	return {
		db: {
			insert: vi.fn(() => insertChain),
			delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
			query: {
				platformStaticAssetPublications: {
					findFirst: vi.fn(async () => null),
				},
			},
		},
	};
});

const storage = {
	objectStorageId: "storage-1",
	provider: "r2",
	status: "active",
	endpoint: "https://account.r2.cloudflarestorage.com",
	region: "auto",
	bucket: "vlyv-static-assets",
	accessKeyId: "access-key",
	secretAccessKey: "secret-key",
	publicBaseUrl: "https://assets.vlyv.dev",
	prefix: "releases",
	forcePathStyle: false,
	metadata: {},
} as PlatformObjectStorage;

const fakeS3 = () => {
	const commands: unknown[] = [];
	return {
		commands,
		client: {
			send: vi.fn(async (command: unknown) => {
				commands.push(command);
				if ((command as any).constructor.name === "ListObjectsV2Command") {
					return { Contents: [], IsTruncated: false };
				}
				return {};
			}),
		} as any,
	};
};

describe("platform static object storage", () => {
	beforeEach(() => {
		persistedValues.length = 0;
	});

	it("rejects path traversal and creates opaque tenant release prefixes", () => {
		expect(() => normalizeStaticAssetPath("../secret.txt")).toThrow(
			"path is invalid",
		);
		expect(normalizeStaticAssetPath("/_next//static/app.js")).toBe(
			"_next/static/app.js",
		);
		const prefix = staticAssetObjectPrefix({
			basePrefix: "releases",
			organizationId: "customer-organization",
			applicationId: "application-1",
			deploymentId: "deployment-1",
		});
		expect(prefix).toMatch(
			/^releases\/[a-f0-9]{16}\/[a-f0-9]{16}\/[a-f0-9]{20}$/,
		);
		expect(prefix).not.toContain("customer-organization");
	});

	it("uploads immutable release objects plus a signed-content manifest record", async () => {
		const { client, commands } = fakeS3();
		const publisher = createS3StaticAssetPublisher({ storage, client });

		const publication = await publisher.publish({
			organizationId: "organization-1",
			applicationId: "application-1",
			deploymentId: "deployment-1",
			files: [
				{
					path: "index.html",
					body: Buffer.from("<h1>vlyv</h1>"),
					contentType: "text/html; charset=utf-8",
					cacheControl: "no-cache",
				},
				{
					path: "assets/app.abcdef.js",
					body: Buffer.from("console.log('vlyv')"),
					contentType: "text/javascript",
					cacheControl: "public, max-age=31536000, immutable",
				},
			],
		});

		expect(publication).toMatchObject({
			fileCount: 2,
			totalBytes:
				Buffer.byteLength("<h1>vlyv</h1>") +
				Buffer.byteLength("console.log('vlyv')"),
			manifestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
		});
		expect(persistedValues).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					deploymentId: "deployment-1",
					lastMeteredAt: expect.any(Date),
				}),
			]),
		);
		expect(publication.publicBaseUrl).toContain(
			"https://assets.vlyv.dev/releases/",
		);
		const puts = commands.filter(
			(command) => (command as any).constructor.name === "PutObjectCommand",
		) as any[];
		expect(puts).toHaveLength(3);
		expect(puts.map((command) => command.input.Key)).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/\/index\.html$/),
				expect.stringMatching(/\/assets\/app\.abcdef\.js$/),
				expect.stringMatching(/\/manifest\.json$/),
			]),
		);
		expect(persistedValues[0]).toMatchObject({
			objectStorageId: "storage-1",
			applicationId: "application-1",
			deploymentId: "deployment-1",
			status: "active",
			fileCount: 2,
		});
	});

	it("cleans a partial release prefix when an upload fails", async () => {
		const commands: unknown[] = [];
		let putCount = 0;
		const client = {
			send: vi.fn(async (command: unknown) => {
				commands.push(command);
				if ((command as any).constructor.name === "PutObjectCommand") {
					putCount += 1;
					if (putCount === 2) throw new Error("object upload failed");
				}
				if ((command as any).constructor.name === "ListObjectsV2Command") {
					return {
						Contents: [{ Key: "releases/orphan/file.js" }],
						IsTruncated: false,
					};
				}
				return {};
			}),
		} as any;
		const publisher = createS3StaticAssetPublisher({ storage, client });

		await expect(
			publisher.publish({
				organizationId: "organization-1",
				applicationId: "application-1",
				deploymentId: "failed-deployment",
				files: [
					{
						path: "one.js",
						body: Buffer.from("1"),
						contentType: "text/javascript",
					},
					{
						path: "two.js",
						body: Buffer.from("2"),
						contentType: "text/javascript",
					},
				],
			}),
		).rejects.toThrow("object upload failed");
		expect(
			commands.some(
				(command) =>
					(command as any).constructor.name === "DeleteObjectsCommand",
			),
		).toBe(true);
	});

	it("rejects managed archive storage without dedicated private KMS policy", () => {
		expect(() =>
			createS3ObjectStorageClient({
				storage: {
					...storage,
					metadata: {
						managedDataBackups: true,
						serverSideEncryption: "AES256",
						publicAccessDisabled: true,
					},
				},
			}),
		).toThrow("private S3 storage with a dedicated KMS key");
	});

	it("requires versioning when verifying managed archive storage", async () => {
		const client = {
			send: vi.fn(async (command: unknown) => {
				const name = (command as any).constructor.name;
				if (name === "GetBucketEncryptionCommand") {
					return {
						ServerSideEncryptionConfiguration: {
							Rules: [
								{
									ApplyServerSideEncryptionByDefault: {
										SSEAlgorithm: "aws:kms",
										KMSMasterKeyID:
											"arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
									},
								},
							],
						},
					};
				}
				if (name === "GetPublicAccessBlockCommand") {
					return {
						PublicAccessBlockConfiguration: {
							BlockPublicAcls: true,
							IgnorePublicAcls: true,
							BlockPublicPolicy: true,
							RestrictPublicBuckets: true,
						},
					};
				}
				if (name === "GetBucketVersioningCommand") return {};
				return {};
			}),
		} as any;
		const objects = createS3ObjectStorageClient({
			storage: {
				...storage,
				provider: "s3",
				metadata: {
					managedDataBackups: true,
					publicAccessDisabled: true,
					serverSideEncryption: "aws:kms",
					kmsKeyId:
						"arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
				},
			},
			client,
		});
		await expect(objects.verifyManagedDataBackups()).rejects.toThrow(
			"enable versioning",
		);
	});

	it("does not report a partial backup deletion as successful", async () => {
		let listCalls = 0;
		const client = {
			send: vi.fn(async (command: unknown) => {
				const name = (command as any).constructor.name;
				if (name === "ListObjectsV2Command") {
					listCalls += 1;
					return listCalls === 1
						? { Contents: [{ Key: "backups/archive/data.dump" }] }
						: { Contents: [] };
				}
				if (name === "DeleteObjectsCommand") {
					return { Errors: [{ Key: "backups/archive/data.dump" }] };
				}
				return {};
			}),
		} as any;
		const objects = createS3ObjectStorageClient({ storage, client });
		await expect(objects.deletePrefix("backups/archive")).rejects.toThrow(
			"did not delete every backup object",
		);
	});

	it("erases every retained version and delete marker for managed archives", async () => {
		let versionCalls = 0;
		const commands: any[] = [];
		const client = {
			send: vi.fn(async (command: any) => {
				commands.push(command);
				const name = command.constructor.name;
				if (name === "ListObjectsV2Command") return { Contents: [] };
				if (name === "ListObjectVersionsCommand") {
					versionCalls += 1;
					return versionCalls === 1
						? {
								Versions: [
									{ Key: "backups/archive/data.dump", VersionId: "v1" },
								],
								DeleteMarkers: [
									{ Key: "backups/archive/data.dump", VersionId: "marker" },
								],
							}
						: { Versions: [], DeleteMarkers: [] };
				}
				return {};
			}),
		} as any;
		const objects = createS3ObjectStorageClient({
			storage: {
				...storage,
				provider: "s3",
				metadata: {
					managedDataBackups: true,
					publicAccessDisabled: true,
					serverSideEncryption: "aws:kms",
					kmsKeyId:
						"arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
				},
			},
			client,
		});

		await expect(
			objects.deletePrefix("backups/archive"),
		).resolves.toBeUndefined();
		const versionDelete = commands.find(
			(command) =>
				command.constructor.name === "DeleteObjectsCommand" &&
				command.input.Delete.Objects.some((object: any) => object.VersionId),
		);
		expect(versionDelete.input.Delete.Objects).toEqual(
			expect.arrayContaining([
				{ Key: "backups/archive/data.dump", VersionId: "v1" },
				{ Key: "backups/archive/data.dump", VersionId: "marker" },
			]),
		);
	});
});
