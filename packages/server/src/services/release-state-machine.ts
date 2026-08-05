import { db } from "@dokploy/server/db";
import {
	applications,
	buildArtifacts,
	deployments,
	type Release,
	type ReleaseEvent,
	type ReleaseState,
	releaseEvents,
	releases,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { BuildExecutionArtifact } from "./build-executor";
import type { RuntimeHealthResult } from "./runtime-scheduler";

const terminalStates = new Set<ReleaseState>([
	"ready",
	"failed",
	"rolled_back",
	"cancelled",
]);

const allowedTransitions: Record<ReleaseState, ReadonlySet<ReleaseState>> = {
	queued: new Set(["preparing", "failed", "cancelled"]),
	preparing: new Set(["building", "failed", "cancelled"]),
	building: new Set(["artifact_ready", "failed", "cancelled"]),
	artifact_ready: new Set(["scheduling", "failed", "cancelled"]),
	scheduling: new Set(["verifying", "failed", "rolling_back", "cancelled"]),
	verifying: new Set(["ready", "failed", "rolling_back", "cancelled"]),
	ready: new Set(["rolling_back"]),
	failed: new Set(["rolling_back"]),
	rolling_back: new Set(["rolled_back", "failed"]),
	rolled_back: new Set(),
	cancelled: new Set(),
};

export const canTransitionRelease = (from: ReleaseState, to: ReleaseState) =>
	from === to || allowedTransitions[from].has(to);

const detailsForError = (error: unknown) => ({
	message: error instanceof Error ? error.message : String(error),
	name: error instanceof Error ? error.name : "Error",
});

export interface ReleaseStateMachine {
	create(input: {
		deploymentId: string;
		applicationId: string;
		runtimeProvider: string;
		metadata?: Record<string, unknown>;
	}): Promise<Release>;
	transition(
		releaseId: string,
		to: ReleaseState,
		details?: Record<string, unknown>,
	): Promise<Release>;
	heartbeat(releaseId: string): Promise<void>;
	attachArtifact(
		releaseId: string,
		artifact: BuildExecutionArtifact,
	): Promise<Release>;
	setPreviousImageRef(
		releaseId: string,
		imageRef: string | null,
	): Promise<void>;
	recordHealth(releaseId: string, result: RuntimeHealthResult): Promise<void>;
	fail(releaseId: string, error: unknown): Promise<Release>;
	get(releaseId: string): Promise<Release>;
	getByDeployment(deploymentId: string): Promise<Release | null>;
	getEvents(releaseId: string): Promise<ReleaseEvent[]>;
	reconcileStale(staleBefore: Date): Promise<number>;
}

const findRelease = async (releaseId: string) => {
	const release = await db.query.releases.findFirst({
		where: eq(releases.releaseId, releaseId),
	});
	if (!release) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Release not found" });
	}
	return release;
};

export const createReleaseStateMachine = (): ReleaseStateMachine => ({
	create: async ({
		deploymentId,
		applicationId,
		runtimeProvider,
		metadata = {},
	}) => {
		const existing = await db.query.releases.findFirst({
			where: eq(releases.deploymentId, deploymentId),
		});
		if (existing) return existing;

		const previous = await db.query.releases.findFirst({
			where: and(
				eq(releases.applicationId, applicationId),
				eq(releases.state, "ready"),
			),
			orderBy: [desc(releases.finishedAt)],
		});

		return db.transaction(async (tx) => {
			const [release] = await tx
				.insert(releases)
				.values({
					deploymentId,
					applicationId,
					previousArtifactId: previous?.artifactId,
					runtimeProvider,
					metadata,
				})
				.onConflictDoNothing({ target: releases.deploymentId })
				.returning();

			if (!release) {
				const concurrent = await tx.query.releases.findFirst({
					where: eq(releases.deploymentId, deploymentId),
				});
				if (concurrent) return concurrent;
				throw new Error("Failed to create durable release");
			}

			await tx.insert(releaseEvents).values({
				releaseId: release.releaseId,
				eventType: "created",
				toState: "queued",
				details: metadata,
			});
			return release;
		});
	},

	transition: async (releaseId, to, details = {}) =>
		db.transaction(async (tx) => {
			const current = await tx.query.releases.findFirst({
				where: eq(releases.releaseId, releaseId),
			});
			if (!current) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Release not found",
				});
			}
			if (current.state === to) return current;
			if (!canTransitionRelease(current.state, to)) {
				throw new TRPCError({
					code: "CONFLICT",
					message: `Invalid release transition: ${current.state} -> ${to}`,
				});
			}

			const now = new Date();
			const [updated] = await tx
				.update(releases)
				.set({
					state: to,
					stateVersion: current.stateVersion + 1,
					heartbeatAt: now,
					updatedAt: now,
					finishedAt: terminalStates.has(to) ? now : null,
					errorMessage:
						to === "failed" && typeof details.message === "string"
							? details.message
							: current.errorMessage,
				})
				.where(
					and(
						eq(releases.releaseId, releaseId),
						eq(releases.stateVersion, current.stateVersion),
						eq(releases.state, current.state),
					),
				)
				.returning();
			if (!updated) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "Release state changed concurrently",
				});
			}

			await tx.insert(releaseEvents).values({
				releaseId,
				eventType:
					to === "rolling_back" ? "rollback_requested" : "transitioned",
				fromState: current.state,
				toState: to,
				details,
			});
			return updated;
		}),

	heartbeat: async (releaseId) => {
		await db
			.update(releases)
			.set({ heartbeatAt: new Date(), updatedAt: new Date() })
			.where(eq(releases.releaseId, releaseId));
	},

	attachArtifact: async (releaseId, artifact) =>
		db.transaction(async (tx) => {
			const release = await tx.query.releases.findFirst({
				where: eq(releases.releaseId, releaseId),
			});
			if (!release) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Release not found",
				});
			}

			const [created] = await tx
				.insert(buildArtifacts)
				.values({
					deploymentId: release.deploymentId,
					applicationId: release.applicationId,
					imageId: artifact.imageId,
					imageDigest: artifact.imageDigest,
					imageRef: artifact.imageRef,
					imageSizeBytes: artifact.imageSizeBytes,
					builder: artifact.builder,
					executor: artifact.executor,
					metadata: artifact.metadata,
				})
				.onConflictDoNothing({ target: buildArtifacts.deploymentId })
				.returning();
			const artifactRecord =
				created ??
				(await tx.query.buildArtifacts.findFirst({
					where: eq(buildArtifacts.deploymentId, release.deploymentId),
				}));
			if (!artifactRecord) throw new Error("Failed to persist build artifact");

			const [updated] = await tx
				.update(releases)
				.set({
					artifactId: artifactRecord.artifactId,
					heartbeatAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(releases.releaseId, releaseId))
				.returning();
			if (!updated) throw new Error("Failed to attach build artifact");

			await tx.insert(releaseEvents).values({
				releaseId,
				eventType: "artifact_recorded",
				fromState: release.state,
				toState: release.state,
				details: {
					artifactId: artifactRecord.artifactId,
					imageDigest: artifactRecord.imageDigest,
					imageRef: artifactRecord.imageRef,
				},
			});
			return updated;
		}),

	setPreviousImageRef: async (releaseId, imageRef) => {
		await db
			.update(releases)
			.set({ previousImageRef: imageRef, updatedAt: new Date() })
			.where(eq(releases.releaseId, releaseId));
	},

	recordHealth: async (releaseId, result) => {
		const release = await findRelease(releaseId);
		await db.insert(releaseEvents).values({
			releaseId,
			eventType: "health_checked",
			fromState: release.state,
			toState: release.state,
			details: {
				passed: result.passed,
				latencyMs: result.latencyMs,
				statusCode: result.statusCode,
				error: result.error,
				endpoint: result.endpoint,
			},
		});
	},

	fail: async (releaseId, error) => {
		const release = await findRelease(releaseId);
		if (terminalStates.has(release.state)) return release;
		return createReleaseStateMachine().transition(
			releaseId,
			"failed",
			detailsForError(error),
		);
	},

	get: findRelease,

	getByDeployment: async (deploymentId) =>
		(await db.query.releases.findFirst({
			where: eq(releases.deploymentId, deploymentId),
		})) ?? null,

	getEvents: async (releaseId) =>
		db.query.releaseEvents.findMany({
			where: eq(releaseEvents.releaseId, releaseId),
			orderBy: [releaseEvents.createdAt],
		}),

	reconcileStale: async (staleBefore) => {
		const active = await db.query.releases.findMany({
			where: and(
				inArray(releases.state, [
					"preparing",
					"building",
					"artifact_ready",
					"scheduling",
					"verifying",
				]),
				lt(releases.heartbeatAt, staleBefore),
			),
		});

		let reconciled = 0;
		for (const release of active) {
			try {
				await db.transaction(async (tx) => {
					const now = new Date();
					const [updated] = await tx
						.update(releases)
						.set({
							state: "failed",
							stateVersion: release.stateVersion + 1,
							errorMessage: "Release heartbeat expired",
							updatedAt: now,
							finishedAt: now,
						})
						.where(
							and(
								eq(releases.releaseId, release.releaseId),
								eq(releases.stateVersion, release.stateVersion),
							),
						)
						.returning();
					if (!updated) return;

					await tx.insert(releaseEvents).values({
						releaseId: release.releaseId,
						eventType: "reconciled",
						fromState: release.state,
						toState: "failed",
						details: { reason: "Release heartbeat expired" },
					});
					await tx
						.update(deployments)
						.set({
							status: "error",
							errorMessage: "Release heartbeat expired",
							finishedAt: now.toISOString(),
						})
						.where(eq(deployments.deploymentId, release.deploymentId));
					await tx
						.update(applications)
						.set({ applicationStatus: "error" })
						.where(eq(applications.applicationId, release.applicationId));
					reconciled += 1;
				});
			} catch (error) {
				console.error("Failed to reconcile release", release.releaseId, error);
			}
		}
		return reconciled;
	},
});
