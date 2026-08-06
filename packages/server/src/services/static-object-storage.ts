import { createHash } from "node:crypto";
import {
	DeleteObjectsCommand,
	GetBucketEncryptionCommand,
	GetObjectCommand,
	GetPublicAccessBlockCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	ListObjectVersionsCommand,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	type PlatformObjectStorage,
	platformStaticAssetPublications,
} from "@dokploy/server/db/schema";
import { and, asc, eq, lte } from "drizzle-orm";
import postgres from "postgres";
import { recordUsageEvent } from "./usage-metering";

const OBJECT_KEY_PATTERN = /^[a-zA-Z0-9._~!$&'()+,;=:@/-]{1,1024}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export type StaticAssetFile = {
	path: string;
	body: Uint8Array;
	contentType: string;
	cacheControl?: string;
};

export type StaticAssetPublication = {
	objectPrefix: string;
	publicBaseUrl: string;
	manifestDigest: string;
	fileCount: number;
	totalBytes: number;
};

export interface StaticAssetPublisher {
	publish(input: {
		organizationId: string;
		applicationId: string;
		deploymentId: string;
		files: StaticAssetFile[];
	}): Promise<StaticAssetPublication>;
	remove(input: { deploymentId: string }): Promise<void>;
}

const normalizePrefix = (value: string) =>
	value
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.replace(/\/{2,}/g, "/");

export const normalizeStaticAssetPath = (value: string) => {
	const normalized = value
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/{2,}/g, "/");
	if (
		!normalized ||
		normalized
			.split("/")
			.some((segment) => segment === "." || segment === "..") ||
		!OBJECT_KEY_PATTERN.test(normalized)
	) {
		throw new Error("Static asset path is invalid");
	}
	return normalized;
};

export const staticAssetObjectPrefix = ({
	basePrefix,
	organizationId,
	applicationId,
	deploymentId,
}: {
	basePrefix: string;
	organizationId: string;
	applicationId: string;
	deploymentId: string;
}) => {
	const tenant = createHash("sha256")
		.update(organizationId)
		.digest("hex")
		.slice(0, 16);
	const application = createHash("sha256")
		.update(applicationId)
		.digest("hex")
		.slice(0, 16);
	const release = createHash("sha256")
		.update(deploymentId)
		.digest("hex")
		.slice(0, 20);
	return [normalizePrefix(basePrefix), tenant, application, release]
		.filter(Boolean)
		.join("/");
};

const publicUrl = (base: string, prefix: string) =>
	`${base.replace(/\/+$/, "")}/${prefix}`;

const assertStorage = (
	storage: PlatformObjectStorage,
	options: { requireActive?: boolean } = {},
) => {
	if (options.requireActive !== false && storage.status !== "active") {
		throw new Error("Platform object storage is not active");
	}
	if (!BUCKET_PATTERN.test(storage.bucket)) {
		throw new Error("Platform object-storage bucket is invalid");
	}
	for (const [value, field] of [
		[storage.endpoint, "endpoint"],
		[storage.publicBaseUrl, "public base URL"],
	] as const) {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error(`Platform object-storage ${field} must use clean HTTPS`);
		}
	}
	if (!storage.accessKeyId || !storage.secretAccessKey) {
		throw new Error("Platform object-storage credentials are required");
	}
	if (
		storage.metadata.serverSideEncryption === "aws:kms" &&
		!storage.metadata.kmsKeyId
	) {
		throw new Error("KMS object encryption requires a KMS key ID");
	}
	if (storage.metadata.managedDataBackups) {
		if (
			storage.provider !== "s3" ||
			storage.metadata.serverSideEncryption !== "aws:kms" ||
			!storage.metadata.kmsKeyId ||
			!/^arn:aws(?:-[a-z]+)?:kms:[a-z0-9-]+:\d{12}:key\/[a-fA-F0-9-]+$/.test(
				storage.metadata.kmsKeyId,
			) ||
			storage.metadata.publicAccessDisabled !== true
		) {
			throw new Error(
				"Managed data archives require private S3 storage with a dedicated KMS key",
			);
		}
	}
};

export const createS3ObjectStorageClient = ({
	storage,
	client,
	allowInactive = false,
}: {
	storage: PlatformObjectStorage;
	client?: S3Client;
	allowInactive?: boolean;
}) => {
	assertStorage(storage, { requireActive: !allowInactive });
	const config: S3ClientConfig = {
		endpoint: storage.endpoint,
		region: storage.region,
		forcePathStyle: storage.forcePathStyle,
		credentials: {
			accessKeyId: storage.accessKeyId,
			secretAccessKey: storage.secretAccessKey,
		},
	};
	const s3 = client ?? new S3Client(config);
	const encryption = storage.metadata.serverSideEncryption;
	const kmsKeyId = storage.metadata.kmsKeyId;

	return {
		verify: async () => {
			await s3.send(new HeadBucketCommand({ Bucket: storage.bucket }));
			return true;
		},
		verifyManagedDataBackups: async () => {
			if (!storage.metadata.managedDataBackups) {
				throw new Error("Storage is not dedicated to managed data backups");
			}
			const [encryption, access] = await Promise.all([
				s3.send(new GetBucketEncryptionCommand({ Bucket: storage.bucket })),
				s3.send(new GetPublicAccessBlockCommand({ Bucket: storage.bucket })),
			]);
			const rule = encryption.ServerSideEncryptionConfiguration?.Rules?.find(
				(candidate) =>
					candidate.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ===
					"aws:kms",
			);
			const configuredKey =
				rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
			if (!configuredKey || configuredKey !== storage.metadata.kmsKeyId) {
				throw new Error("Managed data backup bucket KMS policy is invalid");
			}
			const block = access.PublicAccessBlockConfiguration;
			if (
				!block?.BlockPublicAcls ||
				!block.IgnorePublicAcls ||
				!block.BlockPublicPolicy ||
				!block.RestrictPublicBuckets
			) {
				throw new Error("Managed data backup bucket must block public access");
			}
			return true;
		},
		put: async ({
			key,
			body,
			contentType,
			cacheControl,
		}: StaticAssetFile & { key: string }) => {
			const objectKey = normalizeStaticAssetPath(key);
			await s3.send(
				new PutObjectCommand({
					Bucket: storage.bucket,
					Key: objectKey,
					Body: body,
					ContentLength: body.byteLength,
					ContentType: contentType,
					CacheControl:
						cacheControl ||
						storage.metadata.cacheControl ||
						"public, max-age=3600",
					ServerSideEncryption: encryption,
					SSEKMSKeyId: encryption === "aws:kms" ? kmsKeyId : undefined,
				}),
			);
		},
		get: async (key: string, maxBytes = 1024 * 1024) => {
			const objectKey = normalizeStaticAssetPath(key);
			const response = await s3.send(
				new GetObjectCommand({ Bucket: storage.bucket, Key: objectKey }),
			);
			if (!response.Body)
				throw new Error("Object-storage response had no body");
			if (response.ContentLength && response.ContentLength > maxBytes) {
				throw new Error("Object-storage response exceeded the size limit");
			}
			const bytes = await response.Body.transformToByteArray();
			if (bytes.byteLength > maxBytes) {
				throw new Error("Object-storage response exceeded the size limit");
			}
			return bytes;
		},
		head: async (key: string) => {
			const objectKey = normalizeStaticAssetPath(key);
			const response = await s3.send(
				new HeadObjectCommand({
					Bucket: storage.bucket,
					Key: objectKey,
					ChecksumMode: "ENABLED",
				}),
			);
			return {
				contentLength: response.ContentLength ?? null,
				etag: response.ETag ?? null,
				serverSideEncryption: response.ServerSideEncryption ?? null,
				kmsKeyId: response.SSEKMSKeyId ?? null,
				checksumSha256: response.ChecksumSHA256 ?? null,
				metadata: response.Metadata ?? {},
			};
		},
		deletePrefix: async (prefix: string) => {
			const normalized = `${normalizeStaticAssetPath(prefix).replace(/\/+$/, "")}/`;
			let continuationToken: string | undefined;
			do {
				const page = await s3.send(
					new ListObjectsV2Command({
						Bucket: storage.bucket,
						Prefix: normalized,
						ContinuationToken: continuationToken,
					}),
				);
				const objects = (page.Contents ?? [])
					.map((object) => object.Key)
					.filter((key): key is string => Boolean(key))
					.map((Key) => ({ Key }));
				if (objects.length > 0) {
					const deleted = await s3.send(
						new DeleteObjectsCommand({
							Bucket: storage.bucket,
							Delete: { Objects: objects, Quiet: true },
						}),
					);
					if ((deleted.Errors?.length ?? 0) > 0) {
						throw new Error(
							"Object storage did not delete every backup object",
						);
					}
				}
				continuationToken = page.IsTruncated
					? page.NextContinuationToken
					: undefined;
			} while (continuationToken);
			const remaining = await s3.send(
				new ListObjectsV2Command({
					Bucket: storage.bucket,
					Prefix: normalized,
					MaxKeys: 1,
				}),
			);
			if ((remaining.Contents?.length ?? 0) > 0) {
				throw new Error("Object storage backup prefix is not empty");
			}
			if (!storage.metadata.managedDataBackups) return;
			let keyMarker: string | undefined;
			let versionIdMarker: string | undefined;
			do {
				const versions = await s3.send(
					new ListObjectVersionsCommand({
						Bucket: storage.bucket,
						Prefix: normalized,
						KeyMarker: keyMarker,
						VersionIdMarker: versionIdMarker,
					}),
				);
				const versionedObjects = [
					...(versions.Versions ?? []),
					...(versions.DeleteMarkers ?? []),
				]
					.filter(
						(
							object,
						): object is typeof object & { Key: string; VersionId: string } =>
							Boolean(object.Key && object.VersionId),
					)
					.map((object) => ({
						Key: object.Key,
						VersionId: object.VersionId,
					}));
				if (versionedObjects.length > 0) {
					const deleted = await s3.send(
						new DeleteObjectsCommand({
							Bucket: storage.bucket,
							Delete: { Objects: versionedObjects, Quiet: true },
						}),
					);
					if ((deleted.Errors?.length ?? 0) > 0) {
						throw new Error(
							"Object storage did not delete every backup version",
						);
					}
				}
				keyMarker = versions.IsTruncated ? versions.NextKeyMarker : undefined;
				versionIdMarker = versions.IsTruncated
					? versions.NextVersionIdMarker
					: undefined;
			} while (keyMarker || versionIdMarker);
			const versionCheck = await s3.send(
				new ListObjectVersionsCommand({
					Bucket: storage.bucket,
					Prefix: normalized,
					MaxKeys: 1,
				}),
			);
			if (
				(versionCheck.Versions?.length ?? 0) > 0 ||
				(versionCheck.DeleteMarkers?.length ?? 0) > 0
			) {
				throw new Error("Object storage backup versions are not empty");
			}
		},
	};
};

export const recordStaticAssetPublication = async ({
	storage,
	organizationId,
	applicationId,
	deploymentId,
	objectPrefix,
	publicBaseUrl,
	manifestDigest,
	fileCount,
	totalBytes,
	metadata = {},
}: {
	storage: PlatformObjectStorage;
	organizationId: string;
	applicationId: string;
	deploymentId: string;
	objectPrefix: string;
	publicBaseUrl: string;
	manifestDigest: string;
	fileCount: number;
	totalBytes: number;
	metadata?: Record<string, unknown>;
}) => {
	const observedAt = new Date();
	const [publication] = await db
		.insert(platformStaticAssetPublications)
		.values({
			objectStorageId: storage.objectStorageId,
			applicationId,
			deploymentId,
			status: "active",
			objectPrefix,
			publicBaseUrl,
			manifestDigest,
			fileCount,
			totalBytes,
			lastMeteredAt: new Date(observedAt.getTime() + 60 * 60 * 1_000),
			metadata,
		})
		.onConflictDoUpdate({
			target: platformStaticAssetPublications.deploymentId,
			set: {
				objectStorageId: storage.objectStorageId,
				status: "active",
				objectPrefix,
				publicBaseUrl,
				manifestDigest,
				fileCount,
				totalBytes,
				errorMessage: null,
				metadata,
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!publication) throw new Error("Failed to persist static publication");
	await recordUsageEvent({
		idempotencyKey: `${deploymentId}:static-storage-bytes`,
		organizationId,
		applicationId,
		deploymentId,
		metric: "storage_byte_hours",
		source: "storage",
		quantity: BigInt(totalBytes),
		unit: "byte_hours",
		periodStart: observedAt,
		periodEnd: new Date(observedAt.getTime() + 60 * 60 * 1_000),
		metadata: { objectStorageId: storage.objectStorageId, objectPrefix },
	});
	return publication;
};

export const reconcileStaticStorageUsage = async (
	now = new Date(),
	maxPublications = 100,
) => {
	if (
		!Number.isSafeInteger(maxPublications) ||
		maxPublications < 1 ||
		maxPublications > 1_000
	) {
		throw new Error("Static storage reconciliation limit is invalid");
	}
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended('vlyv:static-storage-usage', 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		return 0;
	}
	try {
		const publications =
			await db.query.platformStaticAssetPublications.findMany({
				where: and(
					eq(platformStaticAssetPublications.status, "active"),
					lte(
						platformStaticAssetPublications.lastMeteredAt,
						new Date(now.getTime() - 60 * 60 * 1_000),
					),
				),
				with: {
					application: {
						with: { environment: { with: { project: true } } },
					},
				},
				orderBy: [asc(platformStaticAssetPublications.lastMeteredAt)],
				limit: maxPublications,
			});
		let reconciled = 0;
		for (const publication of publications) {
			const hours = Math.floor(
				(now.getTime() - publication.lastMeteredAt.getTime()) /
					(60 * 60 * 1_000),
			);
			if (hours < 1 || !publication.application) continue;
			const periodEnd = new Date(
				publication.lastMeteredAt.getTime() + hours * 60 * 60 * 1_000,
			);
			await recordUsageEvent({
				idempotencyKey: `${publication.staticAssetPublicationId}:${periodEnd.toISOString()}:storage-retention`,
				organizationId:
					publication.application.environment.project.organizationId,
				projectId: publication.application.environment.project.projectId,
				environmentId: publication.application.environmentId,
				applicationId: publication.applicationId,
				deploymentId: publication.deploymentId,
				metric: "storage_byte_hours",
				source: "storage",
				quantity: BigInt(publication.totalBytes) * BigInt(hours),
				unit: "byte_hours",
				periodStart: publication.lastMeteredAt,
				periodEnd,
				metadata: {
					objectStorageId: publication.objectStorageId,
					objectPrefix: publication.objectPrefix,
					hours,
				},
			});
			await db
				.update(platformStaticAssetPublications)
				.set({ lastMeteredAt: periodEnd, updatedAt: new Date() })
				.where(
					and(
						eq(
							platformStaticAssetPublications.staticAssetPublicationId,
							publication.staticAssetPublicationId,
						),
						eq(
							platformStaticAssetPublications.lastMeteredAt,
							publication.lastMeteredAt,
						),
					),
				);
			reconciled += 1;
		}
		return reconciled;
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended('vlyv:static-storage-usage', 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};

export const removeStaticAssetPublicationRecord = async (
	deploymentId: string,
) => {
	await db
		.delete(platformStaticAssetPublications)
		.where(eq(platformStaticAssetPublications.deploymentId, deploymentId));
};

export const createS3StaticAssetPublisher = ({
	storage,
	client,
}: {
	storage: PlatformObjectStorage;
	client?: S3Client;
}): StaticAssetPublisher => {
	const objects = createS3ObjectStorageClient({ storage, client });
	return {
		publish: async (input) => {
			if (input.files.length === 0 || input.files.length > 100_000) {
				throw new Error("Static publication requires 1 to 100000 files");
			}
			const normalized = input.files
				.map((file) => ({ ...file, path: normalizeStaticAssetPath(file.path) }))
				.sort((left, right) => left.path.localeCompare(right.path));
			if (
				new Set(normalized.map((file) => file.path)).size !== normalized.length
			) {
				throw new Error("Static publication contains duplicate paths");
			}
			const totalBytes = normalized.reduce(
				(total, file) => total + file.body.byteLength,
				0,
			);
			if (!Number.isSafeInteger(totalBytes) || totalBytes > 10 * 1024 ** 3) {
				throw new Error("Static publication exceeds the 10 GiB release limit");
			}
			const objectPrefix = staticAssetObjectPrefix({
				basePrefix: storage.prefix,
				organizationId: input.organizationId,
				applicationId: input.applicationId,
				deploymentId: input.deploymentId,
			});
			const manifest = normalized.map((file) => ({
				path: file.path,
				bytes: file.body.byteLength,
				sha256: createHash("sha256").update(file.body).digest("hex"),
				contentType: file.contentType,
				cacheControl: file.cacheControl,
			}));
			const manifestBody = Buffer.from(
				JSON.stringify({ version: 1, files: manifest }),
				"utf8",
			);
			const manifestDigest = `sha256:${createHash("sha256")
				.update(manifestBody)
				.digest("hex")}`;
			try {
				const concurrency = 8;
				for (let index = 0; index < normalized.length; index += concurrency) {
					await Promise.all(
						normalized.slice(index, index + concurrency).map((file) =>
							objects.put({
								...file,
								key: `${objectPrefix}/${file.path}`,
							}),
						),
					);
				}
				await objects.put({
					path: "manifest.json",
					key: `${objectPrefix}/manifest.json`,
					body: manifestBody,
					contentType: "application/json",
					cacheControl: "no-cache",
				});
			} catch (error) {
				await objects
					.deletePrefix(objectPrefix)
					.catch((cleanupError) =>
						console.error(
							"Failed to clean partial static asset upload",
							cleanupError,
						),
					);
				throw error;
			}
			const baseUrl = publicUrl(storage.publicBaseUrl, objectPrefix);
			try {
				await recordStaticAssetPublication({
					storage,
					organizationId: input.organizationId,
					applicationId: input.applicationId,
					deploymentId: input.deploymentId,
					objectPrefix,
					publicBaseUrl: baseUrl,
					manifestDigest,
					fileCount: normalized.length,
					totalBytes,
					metadata: { manifestObject: `${objectPrefix}/manifest.json` },
				});
			} catch (error) {
				await Promise.allSettled([
					objects.deletePrefix(objectPrefix),
					removeStaticAssetPublicationRecord(input.deploymentId),
				]);
				throw error;
			}
			return {
				objectPrefix,
				publicBaseUrl: baseUrl,
				manifestDigest,
				fileCount: normalized.length,
				totalBytes,
			};
		},
		remove: async ({ deploymentId }) => {
			const publication =
				await db.query.platformStaticAssetPublications.findFirst({
					where: (table, { eq }) => eq(table.deploymentId, deploymentId),
				});
			if (
				!publication ||
				publication.objectStorageId !== storage.objectStorageId
			) {
				return;
			}
			await objects.deletePrefix(publication.objectPrefix);
			await db
				.delete(platformStaticAssetPublications)
				.where(eq(platformStaticAssetPublications.deploymentId, deploymentId));
		},
	};
};
