import { createHash } from "node:crypto";
import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	managedDataBackups,
	managedDataResources,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import postgres from "postgres";
import {
	createManagedDataPlatformArchive,
	restoreManagedDataPlatformArchive,
	supportsManagedDataPlatformArchiveRestore,
} from "./managed-data-archive";
import {
	planManagedDataBindingQuiesce,
	type QuiescedManagedDataBinding,
	quiesceManagedDataBindings,
	resumeManagedDataBindings,
	synchronizeManagedDataBindingSecrets,
} from "./managed-data-binding";
import {
	assertManagedDataConnectionUri,
	findManagedDataResource,
	getManagedDataProvider,
	withManagedDataResourceMutationLock,
} from "./managed-data-provider";
import { createS3ObjectStorageClient } from "./static-object-storage";

const backupName = (resourceId: string, idempotencyKey: string) =>
	`vlyv-${createHash("sha256")
		.update(`${resourceId}:${idempotencyKey}`)
		.digest("hex")
		.slice(0, 32)}`;

const backupRequestHash = (resourceId: string, idempotencyKey: string) =>
	`sha256:${createHash("sha256")
		.update(`${resourceId}:${idempotencyKey}`)
		.digest("hex")}`;

export const managedDataBackupForTenant = (
	backup: typeof managedDataBackups.$inferSelect,
) => ({
	managedDataBackupId: backup.managedDataBackupId,
	managedDataResourceId: backup.managedDataResourceId,
	status: backup.status,
	sizeBytes: backup.sizeBytes?.toString() ?? null,
	encryptionMode: backup.encryptionMode,
	expiresAt: backup.expiresAt,
	readyAt: backup.readyAt,
	restoredAt: backup.restoredAt,
	error: backup.status === "failed" ? "Managed data backup failed" : null,
	createdAt: backup.createdAt,
	updatedAt: backup.updatedAt,
});

const createManagedDataBackupUnlocked = async (input: {
	managedDataResourceId: string;
	idempotencyKey: string;
	now?: Date;
}) => {
	const now = input.now ?? new Date();
	const resource = await findManagedDataResource(input.managedDataResourceId);
	const existing = await db.query.managedDataBackups.findFirst({
		where: and(
			eq(
				managedDataBackups.managedDataResourceId,
				resource.managedDataResourceId,
			),
			eq(managedDataBackups.idempotencyKey, input.idempotencyKey),
		),
	});
	const requestHash = backupRequestHash(
		resource.managedDataResourceId,
		input.idempotencyKey,
	);
	if (existing && existing.requestHash !== requestHash) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Backup idempotency key was already used",
		});
	}
	if (existing?.status === "ready") {
		return managedDataBackupForTenant(existing);
	}
	if (
		resource.status !== "ready" ||
		!resource.providerResourceId ||
		!resource.backupEnabled
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed data resource is not ready for backup",
		});
	}
	const provider = getManagedDataProvider(resource.provider);
	if (
		!provider.capabilities.backups ||
		!provider.capabilities.encryptionAtRest
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed data provider does not support encrypted backups",
		});
	}
	const expiresAt = new Date(
		now.getTime() + resource.backupRetentionDays * 24 * 60 * 60 * 1_000,
	);
	const [record] = existing
		? await db
				.update(managedDataBackups)
				.set({
					status: "creating",
					requestHash,
					errorMessage: null,
					expiresAt,
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
					idempotencyKey: input.idempotencyKey,
					requestHash,
					kind: "provider_snapshot",
					status: "creating",
					encryptionMode: "provider_kms",
					expiresAt,
					metadata: { provider: resource.provider },
				})
				.returning();
	if (!record) throw new Error("Failed to create managed data backup record");
	let providerBackupId = record.providerBackupId;
	let providerIdentityPersisted = Boolean(record.providerBackupId);
	try {
		const backup = record.providerBackupId
			? await provider.getBackup(
					resource.providerResourceId,
					record.providerBackupId,
				)
			: await provider.createBackup(resource.providerResourceId, {
					idempotencyKey: input.idempotencyKey,
					name: backupName(
						resource.managedDataResourceId,
						input.idempotencyKey,
					),
					expiresAt,
				});
		if (
			backup.encryption !== "provider_kms" &&
			backup.encryption !== "platform_kms"
		) {
			throw new Error("Managed data backup did not attest encryption");
		}
		if (backup.status === "failed") {
			throw new Error("Provider backup failed");
		}
		providerBackupId = backup.backupId;
		const [providerPersisted] = await db
			.update(managedDataBackups)
			.set({
				providerBackupId: backup.backupId,
				status: backup.status === "ready" ? "creating" : "pending",
				sizeBytes: backup.sizeBytes,
				encryptionMode: backup.encryption,
				expiresAt: backup.expiresAt ?? expiresAt,
				errorMessage: null,
				metadata: {
					provider: resource.provider,
					...backup.metadata,
				},
				updatedAt: new Date(),
			})
			.where(
				eq(managedDataBackups.managedDataBackupId, record.managedDataBackupId),
			)
			.returning();
		if (!providerPersisted) {
			throw new Error("Failed to persist provider backup identity");
		}
		providerIdentityPersisted = true;
		const archive = await createManagedDataPlatformArchive({
			resource,
			idempotencyKey: input.idempotencyKey,
			expiresAt,
		});
		if (archive.status !== "ready") {
			throw new Error("Platform-owned backup archive is not ready");
		}
		const [updated] = await db
			.update(managedDataBackups)
			.set({
				status: backup.status === "ready" ? "ready" : "pending",
				sizeBytes: backup.sizeBytes,
				encryptionMode: backup.encryption,
				expiresAt: backup.expiresAt ?? expiresAt,
				readyAt: backup.status === "ready" ? new Date() : null,
				errorMessage: null,
				metadata: {
					provider: resource.provider,
					...backup.metadata,
					platformArchiveId: archive.managedDataBackupId,
				},
				updatedAt: new Date(),
			})
			.where(
				eq(managedDataBackups.managedDataBackupId, record.managedDataBackupId),
			)
			.returning();
		await db
			.update(managedDataResources)
			.set({
				lastBackupAt: now,
				nextBackupAt: new Date(
					now.getTime() + resource.backupIntervalHours * 60 * 60 * 1_000,
				),
				updatedAt: new Date(),
			})
			.where(
				eq(
					managedDataResources.managedDataResourceId,
					resource.managedDataResourceId,
				),
			);
		if (!updated) throw new Error("Failed to persist managed data backup");
		return managedDataBackupForTenant(updated);
	} catch (error) {
		if (
			!providerIdentityPersisted &&
			providerBackupId &&
			resource.providerResourceId
		) {
			await provider
				.deleteBackup(resource.providerResourceId, providerBackupId)
				.catch((cleanupError) =>
					console.error(
						`Failed to compensate provider backup ${providerBackupId}`,
						cleanupError,
					),
				);
		}
		await db
			.update(managedDataBackups)
			.set({
				status: "failed",
				attempts: record.attempts + 1,
				nextAttemptAt: new Date(Date.now() + 60_000),
				errorMessage:
					error instanceof Error
						? error.message.slice(0, 1_000)
						: "Managed data backup failed",
				updatedAt: new Date(),
			})
			.where(
				eq(managedDataBackups.managedDataBackupId, record.managedDataBackupId),
			);
		throw error;
	}
};

export const createManagedDataBackup = async (input: {
	managedDataResourceId: string;
	idempotencyKey: string;
	now?: Date;
}) =>
	withManagedDataResourceMutationLock(input.managedDataResourceId, () =>
		createManagedDataBackupUnlocked(input),
	);

const refreshManagedDataBackupUnlocked = async (
	managedDataBackupId: string,
) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
		with: { resource: true, storage: true },
	});
	if (
		!backup?.resource?.providerResourceId ||
		!backup.providerBackupId ||
		backup.kind !== "provider_snapshot"
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data backup not found",
		});
	}
	const providerBackup = await getManagedDataProvider(
		backup.resource.provider,
	).getBackup(backup.resource.providerResourceId, backup.providerBackupId);
	const archiveId =
		typeof backup.metadata.platformArchiveId === "string"
			? backup.metadata.platformArchiveId
			: null;
	let archive = archiveId
		? await db.query.managedDataBackups.findFirst({
				where: eq(managedDataBackups.managedDataBackupId, archiveId),
			})
		: null;
	if (!archive || archive.status !== "ready") {
		archive = await createManagedDataPlatformArchive({
			resource: backup.resource,
			idempotencyKey: backup.idempotencyKey,
			expiresAt: backup.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
		});
	}
	if (!supportsManagedDataPlatformArchiveRestore(backup.resource.kind)) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Exact restore is unavailable for this database engine",
		});
	}
	const ready = providerBackup.status === "ready" && archive.status === "ready";
	const [updated] = await db
		.update(managedDataBackups)
		.set({
			providerBackupId: providerBackup.backupId,
			status: ready
				? "ready"
				: providerBackup.status === "failed"
					? "failed"
					: "creating",
			sizeBytes: providerBackup.sizeBytes,
			readyAt: ready ? new Date() : backup.readyAt,
			errorMessage:
				providerBackup.status === "failed" ? "Provider backup failed" : null,
			metadata: {
				...backup.metadata,
				...providerBackup.metadata,
				platformArchiveId: archive.managedDataBackupId,
			},
			updatedAt: new Date(),
		})
		.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId))
		.returning();
	if (!updated) throw new Error("Failed to refresh managed data backup");
	return managedDataBackupForTenant(updated);
};

export const refreshManagedDataBackup = async (managedDataBackupId: string) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
	});
	if (!backup) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data backup not found",
		});
	}
	return withManagedDataResourceMutationLock(backup.managedDataResourceId, () =>
		refreshManagedDataBackupUnlocked(managedDataBackupId),
	);
};

const restoreManagedDataBackupUnlocked = async (
	managedDataBackupId: string,
) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
		with: { resource: true, storage: true },
	});
	if (
		!backup?.resource?.providerResourceId ||
		!backup.providerBackupId ||
		(backup.status !== "ready" && backup.status !== "restoring")
	) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed data backup is not ready to restore",
		});
	}
	const provider = getManagedDataProvider(backup.resource.provider);
	const archiveId =
		typeof backup.metadata.platformArchiveId === "string"
			? backup.metadata.platformArchiveId
			: null;
	const archive = archiveId
		? await db.query.managedDataBackups.findFirst({
				where: eq(managedDataBackups.managedDataBackupId, archiveId),
			})
		: null;
	if (!archive || archive.status !== "ready") {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "The independent recovery archive is not ready",
		});
	}
	const continuingRestore = backup.status === "restoring";
	if (continuingRestore && backup.metadata.restorePhase !== "restoring") {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Managed data restore is completing another recovery phase",
		});
	}
	if (!continuingRestore) {
		await createManagedDataBackupUnlocked({
			managedDataResourceId: backup.resource.managedDataResourceId,
			idempotencyKey: `${managedDataBackupId}:pre-restore:${backup.resource.credentialVersion}`,
		});
	}
	const quiescePlan = continuingRestore
		? (backup.metadata.quiescePlan as QuiescedManagedDataBinding[])
		: await planManagedDataBindingQuiesce(
				backup.resource.managedDataResourceId,
			);
	if (!Array.isArray(quiescePlan)) {
		throw new Error("Managed data restore has no durable workload plan");
	}
	let destructiveRestoreStarted = continuingRestore;
	let terminalRestorePersisted = false;
	try {
		if (!continuingRestore)
			await db.transaction(async (tx) => {
				await tx
					.update(managedDataBackups)
					.set({
						status: "restoring",
						metadata: {
							...backup.metadata,
							restorePhase: "quiescing",
							quiescePlan,
						},
						updatedAt: new Date(),
					})
					.where(
						eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
					);
				await tx
					.update(managedDataResources)
					.set({ status: "restoring", updatedAt: new Date() })
					.where(
						eq(
							managedDataResources.managedDataResourceId,
							backup.managedDataResourceId,
						),
					);
			});
		const quiesced = await quiesceManagedDataBindings(
			backup.resource.managedDataResourceId,
			quiescePlan,
		);
		await db
			.update(managedDataBackups)
			.set({
				metadata: {
					...backup.metadata,
					restorePhase: "restoring",
					quiescePlan,
				},
				updatedAt: new Date(),
			})
			.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
		const restoreSource = "platform_archive" as const;
		destructiveRestoreStarted = true;
		const restored = await restoreManagedDataPlatformArchive({
			resource: backup.resource,
			archive,
		}).then(() => ({
			providerResourceId: backup.resource!.providerResourceId!,
			connectionUri: backup.resource!.connectionUri ?? undefined,
		}));
		let status = await provider.getStatus(restored.providerResourceId);
		const deadline = Date.now() + 10 * 60_000;
		while (status.status !== "ready" && Date.now() < deadline) {
			await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
			status = await provider.getStatus(restored.providerResourceId);
		}
		if (status.status !== "ready") {
			throw new Error("Managed data restore did not become healthy");
		}
		// The destructive provider mutation is now terminal. Persist its output
		// before any Secret or workload rollout so retries never repeat it.
		await db.transaction(async (tx) => {
			const restoredConnectionUri =
				status.connectionUri ??
				restored.connectionUri ??
				backup.resource.connectionUri;
			if (!restoredConnectionUri) {
				throw new Error("Managed data restore returned no runtime credentials");
			}
			const validatedConnectionUri = assertManagedDataConnectionUri(
				backup.resource.kind,
				restoredConnectionUri,
			);
			await tx
				.update(managedDataBackups)
				.set({
					status: "restoring",
					errorMessage: null,
					metadata: {
						...backup.metadata,
						restoreSource,
						restorePhase: "rolling_out",
						quiescePlan,
					},
					updatedAt: new Date(),
				})
				.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
			await tx
				.update(managedDataResources)
				.set({
					status: "restoring",
					providerResourceId: restored.providerResourceId,
					connectionUri: validatedConnectionUri,
					credentialVersion: sql`${managedDataResources.credentialVersion} + 1`,
					lastHealthyAt: new Date(),
					errorMessage: null,
					updatedAt: new Date(),
				})
				.where(
					eq(
						managedDataResources.managedDataResourceId,
						backup.managedDataResourceId,
					),
				);
		});
		terminalRestorePersisted = true;
		await db
			.update(managedDataBackups)
			.set({
				metadata: {
					...backup.metadata,
					restoreSource,
					restorePhase: "resuming",
					quiescePlan,
				},
				updatedAt: new Date(),
			})
			.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
		await synchronizeManagedDataBindingSecrets(
			backup.resource.managedDataResourceId,
		);
		await resumeManagedDataBindings(quiesced);
		await db.transaction(async (tx) => {
			await tx
				.update(managedDataBackups)
				.set({
					status: "restored",
					restoredAt: new Date(),
					errorMessage: null,
					metadata: {
						...backup.metadata,
						restoreSource,
						restorePhase: "completed",
					},
					updatedAt: new Date(),
				})
				.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
			await tx
				.update(managedDataResources)
				.set({ status: "ready", updatedAt: new Date() })
				.where(
					eq(
						managedDataResources.managedDataResourceId,
						backup.managedDataResourceId,
					),
				);
		});
		return true;
	} catch (error) {
		if (destructiveRestoreStarted) {
			await db
				.update(managedDataBackups)
				.set({
					status: "restoring",
					errorMessage:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Managed data restore requires reconciliation",
					...(terminalRestorePersisted
						? {}
						: {
								metadata: {
									...backup.metadata,
									restorePhase: "restoring",
									quiescePlan,
								},
							}),
					updatedAt: new Date(),
				})
				.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
			throw error;
		}
		const resumed = await resumeManagedDataBindings(quiescePlan)
			.then(() => true)
			.catch((resumeError) => {
				console.error(
					`Failed to resume applications after managed data restore ${managedDataBackupId}`,
					resumeError,
				);
				return false;
			});
		await db.transaction(async (tx) => {
			await tx
				.update(managedDataBackups)
				.set({
					status: resumed ? "ready" : "restoring",
					restoredAt: backup.restoredAt,
					errorMessage:
						error instanceof Error
							? error.message.slice(0, 1_000)
							: "Managed data restore failed",
					metadata: {
						...backup.metadata,
						restorePhase: resumed ? "aborted" : "quiescing",
						quiescePlan,
					},
					updatedAt: new Date(),
				})
				.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
			await tx
				.update(managedDataResources)
				.set({
					status: resumed ? "ready" : "restoring",
					updatedAt: new Date(),
				})
				.where(
					eq(
						managedDataResources.managedDataResourceId,
						backup.managedDataResourceId,
					),
				);
		});
		throw error;
	}
};

export const restoreManagedDataBackup = async (managedDataBackupId: string) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
	});
	if (!backup) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data backup not found",
		});
	}
	return withManagedDataResourceMutationLock(backup.managedDataResourceId, () =>
		restoreManagedDataBackupUnlocked(managedDataBackupId),
	);
};

export const deleteManagedDataBackupUnderResourceLock = async (
	managedDataBackupId: string,
) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
		with: { resource: true, storage: true },
	});
	if (!backup) return false;
	if (backup.status === "deleted") return true;
	await db
		.update(managedDataBackups)
		.set({ status: "deleting", updatedAt: new Date() })
		.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
	try {
		if (backup.resource?.providerResourceId && backup.providerBackupId) {
			await getManagedDataProvider(backup.resource.provider, {
				allowInactive: true,
			}).deleteBackup(
				backup.resource.providerResourceId,
				backup.providerBackupId,
			);
		}
		if (backup.storage && backup.objectKey) {
			await createS3ObjectStorageClient({
				storage: backup.storage,
				allowInactive: true,
			}).deletePrefix(backup.objectKey.split("/").slice(0, -1).join("/"));
		}
		const archiveId =
			typeof backup.metadata.platformArchiveId === "string"
				? backup.metadata.platformArchiveId
				: null;
		if (archiveId && archiveId !== managedDataBackupId) {
			await deleteManagedDataBackupUnderResourceLock(archiveId);
		}
		await db
			.update(managedDataBackups)
			.set({
				status: "deleted",
				errorMessage: null,
				updatedAt: new Date(),
			})
			.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
		return true;
	} catch (error) {
		await db
			.update(managedDataBackups)
			.set({
				status: "deleting",
				attempts: backup.attempts + 1,
				nextAttemptAt: new Date(Date.now() + 60_000),
				errorMessage:
					error instanceof Error
						? error.message.slice(0, 1_000)
						: "Managed data backup deletion failed",
				updatedAt: new Date(),
			})
			.where(eq(managedDataBackups.managedDataBackupId, managedDataBackupId));
		throw error;
	}
};

export const deleteManagedDataBackup = async (managedDataBackupId: string) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
	});
	if (!backup) return false;
	return withManagedDataResourceMutationLock(backup.managedDataResourceId, () =>
		deleteManagedDataBackupUnderResourceLock(managedDataBackupId),
	);
};

export const listManagedDataBackups = async (managedDataResourceId: string) =>
	(
		await db.query.managedDataBackups.findMany({
			where: and(
				eq(managedDataBackups.managedDataResourceId, managedDataResourceId),
				eq(managedDataBackups.kind, "provider_snapshot"),
			),
			orderBy: [asc(managedDataBackups.createdAt)],
		})
	).map(managedDataBackupForTenant);

const reconcileManagedDataRestores = async (maxResources: number) => {
	const restoring = await db.query.managedDataBackups.findMany({
		where: eq(managedDataBackups.status, "restoring"),
		with: { resource: true },
		orderBy: [asc(managedDataBackups.updatedAt)],
		limit: maxResources,
	});
	let resumed = 0;
	let failed = 0;
	for (const backup of restoring) {
		try {
			await withManagedDataResourceMutationLock(
				backup.managedDataResourceId,
				async () => {
					const phase = backup.metadata.restorePhase;
					const plan = backup.metadata.quiescePlan;
					if (!Array.isArray(plan)) {
						throw new Error(
							"Managed data restore has no durable workload plan",
						);
					}
					if (phase === "restoring") {
						await restoreManagedDataBackupUnlocked(backup.managedDataBackupId);
						resumed += 1;
						return;
					}
					if (
						phase === "rolling_out" ||
						phase === "resuming" ||
						phase === "quiescing"
					) {
						if (phase === "rolling_out" || phase === "resuming") {
							await synchronizeManagedDataBindingSecrets(
								backup.managedDataResourceId,
							);
						}
						await resumeManagedDataBindings(
							plan as QuiescedManagedDataBinding[],
						);
						await db.transaction(async (tx) => {
							await tx
								.update(managedDataBackups)
								.set({
									status: phase === "quiescing" ? "ready" : "restored",
									errorMessage: null,
									metadata: {
										...backup.metadata,
										restorePhase:
											phase === "quiescing" ? "aborted" : "completed",
									},
									updatedAt: new Date(),
								})
								.where(
									eq(
										managedDataBackups.managedDataBackupId,
										backup.managedDataBackupId,
									),
								);
							if (backup.resource) {
								await tx
									.update(managedDataResources)
									.set({
										status: "ready",
										updatedAt: new Date(),
									})
									.where(
										eq(
											managedDataResources.managedDataResourceId,
											backup.managedDataResourceId,
										),
									);
							}
						});
						resumed += 1;
						return;
					}
					failed += 1;
				},
			);
		} catch (error) {
			failed += 1;
			console.error(
				`Failed to recover managed data restore ${backup.managedDataBackupId}`,
				error,
			);
		}
	}
	return { resumed, failed };
};

export const reconcileManagedDataBackups = async (
	now = new Date(),
	maxResources = 50,
) => {
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended('vlyv:managed-data-backups', 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		return { created: 0, refreshed: 0, deleted: 0, failed: 0 };
	}
	try {
		let created = 0;
		let refreshed = 0;
		let deleted = 0;
		let failed = 0;
		const restoreRecovery = await reconcileManagedDataRestores(maxResources);
		refreshed += restoreRecovery.resumed;
		failed += restoreRecovery.failed;
		const due = await db.query.managedDataResources.findMany({
			where: and(
				eq(managedDataResources.status, "ready"),
				eq(managedDataResources.backupEnabled, true),
				lte(managedDataResources.nextBackupAt, now),
			),
			orderBy: [asc(managedDataResources.nextBackupAt)],
			limit: maxResources,
		});
		for (const resource of due) {
			try {
				const owner = await db.query.organization.findFirst({
					where: (table, { eq }) => eq(table.id, resource.organizationId),
					with: { owner: { columns: { isEnterpriseCloud: true } } },
					columns: {
						billingPlan: true,
						billingStatus: true,
						billingCurrentPeriodEnd: true,
						billingLastSyncedAt: true,
					},
				});
				const entitled = Boolean(
					owner &&
						(owner.owner.isEnterpriseCloud ||
							(owner.billingPlan !== null &&
								(owner.billingStatus === "active" ||
									owner.billingStatus === "trialing") &&
								owner.billingLastSyncedAt &&
								now.getTime() - owner.billingLastSyncedAt.getTime() <=
									24 * 60 * 60 * 1_000 &&
								(owner.billingCurrentPeriodEnd === null ||
									owner.billingCurrentPeriodEnd.getTime() >= now.getTime()))),
				);
				if (!entitled) {
					await db
						.update(managedDataResources)
						.set({
							nextBackupAt: new Date(
								now.getTime() + resource.backupIntervalHours * 60 * 60 * 1_000,
							),
							updatedAt: now,
						})
						.where(
							eq(
								managedDataResources.managedDataResourceId,
								resource.managedDataResourceId,
							),
						);
					continue;
				}
				await createManagedDataBackup({
					managedDataResourceId: resource.managedDataResourceId,
					idempotencyKey: `${resource.managedDataResourceId}:${resource.nextBackupAt?.toISOString()}:scheduled`,
					now,
				});
				created += 1;
			} catch (error) {
				failed += 1;
				console.error(
					`Failed to create managed backup for ${resource.managedDataResourceId}`,
					error,
				);
			}
		}
		const pending = await db.query.managedDataBackups.findMany({
			where: and(
				eq(managedDataBackups.kind, "provider_snapshot"),
				inArray(managedDataBackups.status, ["pending", "creating"]),
				lte(managedDataBackups.nextAttemptAt, now),
			),
			orderBy: [asc(managedDataBackups.createdAt)],
			limit: maxResources,
		});
		for (const backup of pending) {
			try {
				await refreshManagedDataBackup(backup.managedDataBackupId);
				refreshed += 1;
			} catch (error) {
				failed += 1;
				console.error(
					`Failed to refresh managed backup ${backup.managedDataBackupId}`,
					error,
				);
			}
		}
		const expired = await db.query.managedDataBackups.findMany({
			where: and(
				inArray(managedDataBackups.status, ["ready", "restored", "failed"]),
				lte(managedDataBackups.expiresAt, now),
			),
			orderBy: [asc(managedDataBackups.expiresAt)],
			limit: maxResources,
		});
		const deleting = await db.query.managedDataBackups.findMany({
			where: and(
				eq(managedDataBackups.status, "deleting"),
				lte(managedDataBackups.nextAttemptAt, now),
			),
			orderBy: [asc(managedDataBackups.nextAttemptAt)],
			limit: maxResources,
		});
		expired.push(...deleting);
		for (const backup of expired) {
			try {
				await deleteManagedDataBackup(backup.managedDataBackupId);
				deleted += 1;
			} catch (error) {
				failed += 1;
				console.error(
					`Failed to expire managed backup ${backup.managedDataBackupId}`,
					error,
				);
			}
		}
		return { created, refreshed, deleted, failed };
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended('vlyv:managed-data-backups', 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};
