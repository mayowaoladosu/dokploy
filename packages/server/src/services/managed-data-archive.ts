import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import {
	type ManagedDataBackup,
	type ManagedDataKind,
	type ManagedDataResource,
	managedDataBackups,
	platformClusters,
	platformObjectStorages,
} from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createKubernetesControlPlane } from "./kubernetes/client";
import { buildKubernetesManagedDataBackupManifests } from "./kubernetes/managed-data-backup-manifests";
import type { KubernetesManifest } from "./kubernetes/manifests";
import {
	createS3ObjectStorageClient,
	staticAssetObjectPrefix,
} from "./static-object-storage";

const terminationSchema = z.object({
	objectKey: z.string().min(1).max(1_024),
	checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
	sizeBytes: z
		.number()
		.int()
		.positive()
		.max(110 * 1024 ** 3),
});

const nameFor = (backupId: string) =>
	`data-backup-${createHash("sha256")
		.update(backupId)
		.digest("hex")
		.slice(0, 20)}`;
const exactArchiveRestoreKinds = new Set<ManagedDataKind>([
	"postgres",
	"mongo",
	"redis",
]);
export const supportsManagedDataPlatformArchiveRestore = (
	kind: ManagedDataKind,
) => exactArchiveRestoreKinds.has(kind);

const applyOwnedManagedDataJob = async ({
	client,
	manifests,
	namespace,
	name,
}: {
	client: ReturnType<typeof createKubernetesControlPlane>;
	manifests: KubernetesManifest[];
	namespace: string;
	name: string;
}) => {
	const namespaceManifest = manifests.find(
		(manifest) => manifest.kind === "Namespace",
	);
	const serviceAccount = manifests.find(
		(manifest) => manifest.kind === "ServiceAccount",
	);
	const job = manifests.find((manifest) => manifest.kind === "Job");
	const secret = manifests.find((manifest) => manifest.kind === "Secret");
	const networkPolicy = manifests.find(
		(manifest) => manifest.kind === "NetworkPolicy",
	);
	if (
		!namespaceManifest ||
		!serviceAccount ||
		!job ||
		!secret ||
		!networkPolicy
	) {
		throw new Error("Managed data job manifests are incomplete");
	}
	// Create the non-secret identity and Job first so Kubernetes assigns the
	// authoritative owner UID. The pod waits for its Secret until the next apply.
	await client.apply([namespaceManifest, serviceAccount, job]);
	const createdJob = await client.readJob(namespace, name);
	const uid = createdJob?.metadata?.uid;
	if (!uid) throw new Error("Managed data job did not receive an owner UID");
	const ownerReferences = [
		{
			apiVersion: "batch/v1",
			kind: "Job",
			name,
			uid,
			controller: true,
			blockOwnerDeletion: false,
		},
	];
	const ownedSecret = {
		...secret,
		metadata: { ...secret.metadata, ownerReferences },
	};
	const ownedNetworkPolicy = {
		...networkPolicy,
		metadata: { ...networkPolicy.metadata, ownerReferences },
	};
	await client.apply([ownedSecret, ownedNetworkPolicy]);
	return {
		secret: ownedSecret,
		serviceAccount,
		job,
		networkPolicy: ownedNetworkPolicy,
	};
};

const clusterFor = async (resource: ManagedDataResource) => {
	const clusters = await db.query.platformClusters.findMany({
		where: and(
			eq(platformClusters.runtime, "kubernetes"),
			eq(platformClusters.status, "active"),
			...(resource.regionId
				? [eq(platformClusters.regionId, resource.regionId)]
				: []),
		),
		with: { nodePools: true },
	});
	return clusters.find((cluster) => cluster.isDefault) ?? clusters[0] ?? null;
};

export const assertManagedDataBackupPlatformReadiness = async () => {
	const [clusters, storages] = await Promise.all([
		db.query.platformClusters.findMany({
			where: and(
				eq(platformClusters.runtime, "kubernetes"),
				eq(platformClusters.status, "active"),
			),
		}),
		db.query.platformObjectStorages.findMany({
			where: eq(platformObjectStorages.status, "active"),
		}),
	]);
	const cluster =
		clusters.find((candidate) => candidate.isDefault) ?? clusters[0];
	if (
		!cluster?.metadata.managedDataBackupImage ||
		!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(
			cluster.metadata.managedDataBackupImage,
		)
	) {
		throw new Error("Managed data backup worker is not ready");
	}
	const storage = storages.find(
		(candidate) => candidate.metadata.managedDataBackups === true,
	);
	if (!storage) throw new Error("Managed data backup storage is not ready");
	const objects = createS3ObjectStorageClient({ storage });
	await objects.verifyManagedDataBackups();
	await objects.verifyManagedDataBackupWrite();
	return true;
};

export const createManagedDataPlatformArchive = async ({
	resource,
	idempotencyKey,
	expiresAt,
}: {
	resource: ManagedDataResource;
	idempotencyKey: string;
	expiresAt: Date;
}) => {
	const archiveIdempotencyKey = `${idempotencyKey}:platform-archive`;
	const existing = await db.query.managedDataBackups.findFirst({
		where: and(
			eq(
				managedDataBackups.managedDataResourceId,
				resource.managedDataResourceId,
			),
			eq(managedDataBackups.idempotencyKey, archiveIdempotencyKey),
		),
	});
	if (existing?.status === "ready") return existing;
	if (!resource.connectionUri) {
		throw new Error("Managed data platform archive requires a connection URI");
	}
	const [cluster, storages] = await Promise.all([
		clusterFor(resource),
		db.query.platformObjectStorages.findMany({
			where: eq(platformObjectStorages.status, "active"),
		}),
	]);
	const storage = storages.find(
		(candidate) => candidate.metadata.managedDataBackups === true,
	);
	if (!cluster?.metadata.managedDataBackupImage) {
		throw new Error("Managed data backup worker is not configured");
	}
	if (!storage)
		throw new Error("Managed data backup storage is not configured");
	if (
		storage.provider !== "s3" ||
		storage.metadata.serverSideEncryption !== "aws:kms" ||
		!storage.metadata.kmsKeyId ||
		storage.metadata.publicAccessDisabled !== true
	) {
		throw new Error("Managed data backup storage is not KMS protected");
	}
	await createS3ObjectStorageClient({
		storage,
	}).verifyManagedDataBackups();
	const requestHash = `sha256:${createHash("sha256")
		.update(`${resource.managedDataResourceId}:${archiveIdempotencyKey}`)
		.digest("hex")}`;
	const [record] = existing
		? await db
				.update(managedDataBackups)
				.set({
					status: "creating",
					objectStorageId: storage.objectStorageId,
					expiresAt,
					errorMessage: null,
					metadata: { clusterId: cluster.clusterId },
					requestHash,
					attempts: existing.attempts + 1,
					nextAttemptAt: new Date(),
					updatedAt: new Date(),
				})
				.where(
					eq(
						managedDataBackups.managedDataBackupId,
						existing.managedDataBackupId,
					),
				)
				.returning()
		: await db
				.insert(managedDataBackups)
				.values({
					managedDataResourceId: resource.managedDataResourceId,
					idempotencyKey: archiveIdempotencyKey,
					requestHash,
					kind: "platform_archive",
					status: "creating",
					objectStorageId: storage.objectStorageId,
					encryptionMode: "platform_kms",
					expiresAt,
					metadata: { clusterId: cluster.clusterId },
				})
				.returning();
	if (!record) throw new Error("Failed to create platform archive record");
	const objectPrefix = staticAssetObjectPrefix({
		basePrefix: `${storage.prefix}/managed-data`,
		organizationId: resource.organizationId,
		applicationId: resource.managedDataResourceId,
		deploymentId: record.managedDataBackupId,
	});
	const objectKey = `${objectPrefix}/data.dump`;
	const namespace =
		cluster.metadata.managedDataBackupNamespace || "vlyv-data-backups";
	const name = nameFor(record.managedDataBackupId);
	const systemPool = cluster.nodePools.find(
		(pool) => pool.purpose === "system" && pool.status === "active",
	);
	const client = createKubernetesControlPlane({
		kubeconfig: cluster.kubeconfig,
		inCluster: cluster.metadata.inCluster,
	});
	const manifests = buildKubernetesManagedDataBackupManifests({
		name,
		namespace,
		image: cluster.metadata.managedDataBackupImage,
		kind: resource.kind,
		connectionUri: resource.connectionUri,
		objectKey,
		storageProvider: storage.provider,
		storageEndpoint: storage.endpoint,
		storageRegion: storage.region,
		storageBucket: storage.bucket,
		storageAccessKeyId: storage.accessKeyId,
		storageSecretAccessKey: storage.secretAccessKey,
		serverSideEncryption: storage.metadata.serverSideEncryption,
		kmsKeyId: storage.metadata.kmsKeyId,
		nodeSelector: systemPool?.labels,
		tolerations: systemPool?.taints,
		activeDeadlineSeconds: 3_600,
	});
	const secret = manifests.find((manifest) => manifest.kind === "Secret");
	const serviceAccount = manifests.find(
		(manifest) => manifest.kind === "ServiceAccount",
	);
	const job = manifests.find((manifest) => manifest.kind === "Job");
	const networkPolicy = manifests.find(
		(manifest) => manifest.kind === "NetworkPolicy",
	);
	try {
		await applyOwnedManagedDataJob({
			client,
			manifests,
			namespace,
			name,
		});
		const deadline = Date.now() + 60 * 60 * 1_000;
		let metadata: z.infer<typeof terminationSchema> | null = null;
		while (Date.now() < deadline) {
			const current = await client.readJob(namespace, name);
			if (current?.status?.failed && current.status.failed > 0) {
				throw new Error("Managed data backup job failed");
			}
			if (current?.status?.succeeded && current.status.succeeded > 0) {
				const pods = await client.listPods(namespace, `job-name=${name}`);
				const status = pods[0]?.status?.containerStatuses?.find(
					(container) => container.name === "backup",
				)?.state?.terminated;
				if (!status || status.exitCode !== 0 || !status.message) {
					throw new Error(
						"Managed data backup job returned no trusted metadata",
					);
				}
				metadata = terminationSchema.parse(JSON.parse(status.message));
				break;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
		}
		if (!metadata || metadata.objectKey !== objectKey) {
			throw new Error(
				"Managed data backup job timed out or returned mismatched metadata",
			);
		}
		const object = await createS3ObjectStorageClient({ storage }).head(
			objectKey,
		);
		if (object.contentLength !== metadata.sizeBytes) {
			throw new Error(
				"Managed data backup object size did not match trusted metadata",
			);
		}
		if (
			object.serverSideEncryption !== "aws:kms" ||
			object.kmsKeyId !== storage.metadata.kmsKeyId
		) {
			throw new Error(
				"Managed data backup object did not use the required KMS key",
			);
		}
		if (object.metadata["vlyv-sha256"] !== metadata.checksum) {
			throw new Error(
				"Managed data backup object checksum metadata is invalid",
			);
		}
		const [updated] = await db
			.update(managedDataBackups)
			.set({
				status: "ready",
				objectKey,
				checksum: metadata.checksum,
				sizeBytes: BigInt(metadata.sizeBytes),
				readyAt: new Date(),
				metadata: {
					clusterId: cluster.clusterId,
					etag: object.etag,
					kmsKeyId: object.kmsKeyId,
				},
				updatedAt: new Date(),
			})
			.where(
				eq(managedDataBackups.managedDataBackupId, record.managedDataBackupId),
			)
			.returning();
		if (!updated) throw new Error("Failed to persist platform archive");
		return updated;
	} catch (error) {
		await Promise.allSettled([
			createS3ObjectStorageClient({ storage }).deletePrefix(objectPrefix),
			db
				.update(managedDataBackups)
				.set({
					status: "failed",
					attempts: record.attempts + 1,
					nextAttemptAt: new Date(Date.now() + 60_000),
					errorMessage:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Platform archive failed",
					updatedAt: new Date(),
				})
				.where(
					eq(
						managedDataBackups.managedDataBackupId,
						record.managedDataBackupId,
					),
				),
		]);
		throw error;
	} finally {
		await Promise.allSettled([
			...(secret ? [client.delete(secret)] : []),
			...(serviceAccount ? [client.delete(serviceAccount)] : []),
			...(job ? [client.delete(job)] : []),
			...(networkPolicy ? [client.delete(networkPolicy)] : []),
		]);
	}
};

export const restoreManagedDataPlatformArchive = async ({
	resource,
	archive,
}: {
	resource: ManagedDataResource;
	archive: ManagedDataBackup;
}) => {
	if (!supportsManagedDataPlatformArchiveRestore(resource.kind)) {
		throw new Error(
			"Exact platform archive restore is unavailable for this database engine",
		);
	}
	if (
		archive.managedDataResourceId !== resource.managedDataResourceId ||
		archive.kind !== "platform_archive" ||
		archive.status !== "ready" ||
		!archive.objectStorageId ||
		!archive.objectKey ||
		!archive.checksum ||
		!archive.sizeBytes ||
		!resource.connectionUri
	) {
		throw new Error("Managed data platform archive is not restorable");
	}
	const [cluster, storage] = await Promise.all([
		clusterFor(resource),
		db.query.platformObjectStorages.findFirst({
			where: eq(
				platformObjectStorages.objectStorageId,
				archive.objectStorageId,
			),
		}),
	]);
	if (!cluster?.metadata.managedDataBackupImage || !storage) {
		throw new Error("Managed data restore infrastructure is unavailable");
	}
	const objects = createS3ObjectStorageClient({ storage });
	await objects.verifyManagedDataBackups();
	const object = await objects.head(archive.objectKey);
	if (
		object.contentLength !== Number(archive.sizeBytes) ||
		object.serverSideEncryption !== "aws:kms" ||
		object.kmsKeyId !== storage.metadata.kmsKeyId ||
		object.metadata["vlyv-sha256"] !== archive.checksum
	) {
		throw new Error("Managed data archive integrity verification failed");
	}
	const namespace =
		cluster.metadata.managedDataBackupNamespace || "vlyv-data-backups";
	const name = `data-restore-${createHash("sha256")
		.update(archive.managedDataBackupId)
		.digest("hex")
		.slice(0, 20)}`;
	const systemPool = cluster.nodePools.find(
		(pool) => pool.purpose === "system" && pool.status === "active",
	);
	const client = createKubernetesControlPlane({
		kubeconfig: cluster.kubeconfig,
		inCluster: cluster.metadata.inCluster,
	});
	const manifests = buildKubernetesManagedDataBackupManifests({
		name,
		namespace,
		image: cluster.metadata.managedDataBackupImage,
		kind: resource.kind,
		connectionUri: resource.connectionUri,
		objectKey: archive.objectKey,
		storageProvider: storage.provider,
		storageEndpoint: storage.endpoint,
		storageRegion: storage.region,
		storageBucket: storage.bucket,
		storageAccessKeyId: storage.accessKeyId,
		storageSecretAccessKey: storage.secretAccessKey,
		serverSideEncryption: storage.metadata.serverSideEncryption,
		kmsKeyId: storage.metadata.kmsKeyId,
		operation: "restore",
		expectedChecksum: archive.checksum,
		nodeSelector: systemPool?.labels,
		tolerations: systemPool?.taints,
		activeDeadlineSeconds: 3_600,
	});
	const secret = manifests.find((manifest) => manifest.kind === "Secret");
	const serviceAccount = manifests.find(
		(manifest) => manifest.kind === "ServiceAccount",
	);
	const job = manifests.find((manifest) => manifest.kind === "Job");
	const networkPolicy = manifests.find(
		(manifest) => manifest.kind === "NetworkPolicy",
	);
	try {
		await applyOwnedManagedDataJob({
			client,
			manifests,
			namespace,
			name,
		});
		const deadline = Date.now() + 60 * 60_000;
		while (Date.now() < deadline) {
			const current = await client.readJob(namespace, name);
			if (current?.status?.failed && current.status.failed > 0) {
				throw new Error("Managed data restore job failed");
			}
			if (current?.status?.succeeded && current.status.succeeded > 0) {
				const pods = await client.listPods(namespace, `job-name=${name}`);
				const status = pods[0]?.status?.containerStatuses?.find(
					(container) => container.name === "backup",
				)?.state?.terminated;
				if (!status || status.exitCode !== 0 || !status.message) {
					throw new Error("Managed data restore returned no trusted metadata");
				}
				const restored = terminationSchema.parse(JSON.parse(status.message));
				if (
					restored.objectKey !== archive.objectKey ||
					restored.checksum !== archive.checksum ||
					BigInt(restored.sizeBytes) !== archive.sizeBytes
				) {
					throw new Error(
						"Managed data restore metadata did not match archive",
					);
				}
				return true;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
		}
		throw new Error("Managed data restore job timed out");
	} finally {
		await Promise.allSettled([
			...(secret ? [client.delete(secret)] : []),
			...(serviceAccount ? [client.delete(serviceAccount)] : []),
			...(job ? [client.delete(job)] : []),
			...(networkPolicy ? [client.delete(networkPolicy)] : []),
		]);
	}
};
