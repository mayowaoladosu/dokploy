import { createHash } from "node:crypto";
import {
	DeleteObjectsCommand,
	HeadBucketCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { db } from "@dokploy/server/db";
import {
	type PlatformObjectStorage,
	platformStaticAssetPublications,
} from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";
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
					await s3.send(
						new DeleteObjectsCommand({
							Bucket: storage.bucket,
							Delete: { Objects: objects, Quiet: true },
						}),
					);
				}
				continuationToken = page.IsTruncated
					? page.NextContinuationToken
					: undefined;
			} while (continuationToken);
		},
	};
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
			const [publication] = await db
				.insert(platformStaticAssetPublications)
				.values({
					objectStorageId: storage.objectStorageId,
					applicationId: input.applicationId,
					deploymentId: input.deploymentId,
					status: "active",
					objectPrefix,
					publicBaseUrl: baseUrl,
					manifestDigest,
					fileCount: normalized.length,
					totalBytes,
					metadata: { manifestObject: `${objectPrefix}/manifest.json` },
				})
				.onConflictDoUpdate({
					target: platformStaticAssetPublications.deploymentId,
					set: {
						objectStorageId: storage.objectStorageId,
						status: "active",
						objectPrefix,
						publicBaseUrl: baseUrl,
						manifestDigest,
						fileCount: normalized.length,
						totalBytes,
						errorMessage: null,
						updatedAt: new Date(),
					},
				})
				.returning();
			if (!publication) throw new Error("Failed to persist static publication");
			const observedAt = new Date();
			await recordUsageEvent({
				idempotencyKey: `${input.deploymentId}:static-storage-bytes`,
				organizationId: input.organizationId,
				applicationId: input.applicationId,
				deploymentId: input.deploymentId,
				metric: "storage_byte_hours",
				source: "storage",
				quantity: BigInt(totalBytes),
				unit: "byte_hours",
				periodStart: observedAt,
				periodEnd: new Date(observedAt.getTime() + 60 * 60 * 1_000),
				metadata: {
					objectStorageId: storage.objectStorageId,
					objectPrefix,
				},
			});
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
