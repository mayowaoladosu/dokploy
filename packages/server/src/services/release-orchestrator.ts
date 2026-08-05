import {
	type BuildExecutionArtifact,
	type BuildExecutor,
	createShellBuildExecutor,
} from "./build-executor";
import type { Deployment } from "./deployment";
import { createSwarmEdgeRouter, type EdgeRouter } from "./edge-router";
import {
	createReleaseStateMachine,
	type ReleaseStateMachine,
} from "./release-state-machine";
import type {
	ApplicationReleaseIntent,
	ReleaseApplication,
} from "./release-types";
import {
	createSwarmRuntimeScheduler,
	type RuntimeHealthResult,
	type RuntimeScheduler,
} from "./runtime-scheduler";
import {
	createApplicationSourcePreparer,
	type SourcePreparer,
} from "./source-preparer";
import {
	createDatabaseTelemetrySink,
	recordReleaseTelemetryBestEffort,
	type TelemetrySink,
} from "./telemetry-sink";
import { createUsageMeter, type UsageMeter } from "./usage-metering";

export type ReleaseExecutionResult = {
	releaseId: string;
	artifact: BuildExecutionArtifact;
	health: RuntimeHealthResult;
};

export interface ReleaseOrchestrator {
	execute(input: {
		application: ReleaseApplication;
		deployment: Deployment;
		intent: ApplicationReleaseIntent;
	}): Promise<ReleaseExecutionResult>;
	remove(input: { application: ReleaseApplication }): Promise<void>;
}

export type ReleaseOrchestratorDependencies = {
	buildExecutor: BuildExecutor;
	runtimeScheduler: RuntimeScheduler;
	stateMachine: ReleaseStateMachine;
	sourcePreparer: SourcePreparer;
	edgeRouter: EdgeRouter;
	telemetrySink: TelemetrySink;
	usageMeter: UsageMeter;
	heartbeatIntervalMs: number;
};

const persistWithRetry = async (
	operation: () => Promise<unknown>,
	maxAttempts = 3,
) => {
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await operation();
			return;
		} catch (error) {
			lastError = error;
			if (attempt < maxAttempts) {
				await new Promise<void>((resolve) =>
					setTimeout(resolve, 100 * 2 ** (attempt - 1)),
				);
			}
		}
	}
	throw lastError;
};

export const createReleaseOrchestrator = (
	overrides: Partial<ReleaseOrchestratorDependencies> = {},
): ReleaseOrchestrator => {
	const dependencies: ReleaseOrchestratorDependencies = {
		buildExecutor: createShellBuildExecutor(),
		runtimeScheduler: createSwarmRuntimeScheduler(),
		stateMachine: createReleaseStateMachine(),
		sourcePreparer: createApplicationSourcePreparer({
			registryCredentialMode: "inline",
			uploadApplicationRegistries: true,
		}),
		edgeRouter: createSwarmEdgeRouter(),
		telemetrySink: createDatabaseTelemetrySink(),
		usageMeter: createUsageMeter(),
		heartbeatIntervalMs: 30_000,
		...overrides,
	};

	return {
		remove: async ({ application }) => {
			const results = await Promise.allSettled([
				dependencies.edgeRouter.withdraw({ application }),
				dependencies.runtimeScheduler.remove({ application }),
			]);
			const failure = results.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (failure) throw failure.reason;
		},
		execute: async ({ application, deployment, intent }) => {
			const organizationId = application.environment.project.organizationId;
			await dependencies.usageMeter.assertBuildAllowed(organizationId);
			const release = await dependencies.stateMachine.create({
				deploymentId: deployment.deploymentId,
				applicationId: application.applicationId,
				runtimeProvider: dependencies.runtimeScheduler.provider,
				metadata: {
					buildExecutor: dependencies.buildExecutor.name,
					buildIsolation: dependencies.buildExecutor.isolation,
				},
			});
			await recordReleaseTelemetryBestEffort(() =>
				dependencies.telemetrySink.record({
					type: "release.initialized",
					deploymentId: deployment.deploymentId,
					applicationId: application.applicationId,
				}),
			);

			const heartbeat = setInterval(() => {
				void dependencies.stateMachine
					.heartbeat(release.releaseId)
					.catch((error) =>
						console.error("Failed to heartbeat release", error),
					);
			}, dependencies.heartbeatIntervalMs);
			heartbeat.unref?.();

			let runtimeMutationStarted = false;
			let edgePublicationStarted = false;
			let previousImageRef: string | null = null;
			try {
				await dependencies.stateMachine.transition(
					release.releaseId,
					"preparing",
				);
				previousImageRef =
					await dependencies.runtimeScheduler.getCurrentImage(application);
				await dependencies.stateMachine.setPreviousImageRef(
					release.releaseId,
					previousImageRef,
				);

				await dependencies.stateMachine.transition(
					release.releaseId,
					"building",
				);
				const prepared = await dependencies.sourcePreparer.prepare({
					application,
					intent,
					workspace:
						dependencies.buildExecutor.isolation === "ephemeral"
							? "fresh"
							: "persistent",
				});
				const artifact = await dependencies.buildExecutor.execute({
					application,
					deploymentId: deployment.deploymentId,
					sourceCommand: prepared.sourceCommand,
					buildCommand: prepared.buildCommand,
					logPath: deployment.logPath,
					buildServerId:
						application.buildServerId || application.serverId || null,
				});
				await recordReleaseTelemetryBestEffort(() =>
					dependencies.telemetrySink.record({
						type: "build.completed",
						deploymentId: deployment.deploymentId,
						durationMs: artifact.durationMs,
						imageSizeBytes: artifact.imageSizeBytes,
					}),
				);
				await persistWithRetry(() =>
					dependencies.usageMeter.recordBuild({
						organizationId,
						projectId: application.environment.project.projectId,
						environmentId: application.environmentId,
						applicationId: application.applicationId,
						deploymentId: deployment.deploymentId,
						durationMs: artifact.durationMs,
						imageSizeBytes: artifact.imageSizeBytes,
					}),
				);
				await persistWithRetry(() =>
					dependencies.stateMachine.attachArtifact(release.releaseId, artifact),
				);
				await dependencies.stateMachine.transition(
					release.releaseId,
					"artifact_ready",
					{ imageRef: artifact.imageRef, imageDigest: artifact.imageDigest },
				);

				await dependencies.stateMachine.transition(
					release.releaseId,
					"scheduling",
				);
				runtimeMutationStarted = true;
				const runtimeStartedAt = Date.now();
				await dependencies.runtimeScheduler.schedule({
					application,
					artifact,
				});
				const readinessDurationMs = Date.now() - runtimeStartedAt;
				await recordReleaseTelemetryBestEffort(() =>
					dependencies.telemetrySink.record({
						type: "runtime.ready",
						deploymentId: deployment.deploymentId,
						runtimeDurationMs: readinessDurationMs,
						readinessDurationMs,
					}),
				);

				await dependencies.stateMachine.transition(
					release.releaseId,
					"verifying",
				);
				edgePublicationStarted = true;
				const publication = await dependencies.edgeRouter.publish({
					releaseId: release.releaseId,
					deploymentId: deployment.deploymentId,
					application,
				});
				await recordReleaseTelemetryBestEffort(() =>
					dependencies.telemetrySink.record({
						type: "edge.published",
						deploymentId: deployment.deploymentId,
						publication,
					}),
				);
				const health = await dependencies.runtimeScheduler.verifyHealth({
					application,
				});
				await dependencies.stateMachine.recordHealth(release.releaseId, health);
				await recordReleaseTelemetryBestEffort(() =>
					dependencies.telemetrySink.record({
						type: "health.completed",
						deploymentId: deployment.deploymentId,
						result: health,
					}),
				);
				if (!health.passed) {
					throw new Error(health.error || "Runtime health verification failed");
				}

				await dependencies.stateMachine.transition(release.releaseId, "ready", {
					imageRef: artifact.imageRef,
				});
				return { releaseId: release.releaseId, artifact, health };
			} catch (error) {
				if (
					edgePublicationStarted &&
					!previousImageRef &&
					(intent.kind === "preview-deploy" ||
						intent.kind === "preview-rebuild")
				) {
					await dependencies.edgeRouter
						.withdraw({ application })
						.catch((withdrawError) =>
							console.error(
								"Failed to withdraw preview edge route",
								withdrawError,
							),
						);
				}
				if (runtimeMutationStarted && previousImageRef) {
					const rollbackImageRef = previousImageRef;
					try {
						await dependencies.stateMachine.transition(
							release.releaseId,
							"rolling_back",
							{
								reason: error instanceof Error ? error.message : String(error),
								imageRef: rollbackImageRef,
							},
						);
						const rollbackStatus = await dependencies.runtimeScheduler.rollback(
							{
								application,
								imageRef: rollbackImageRef,
							},
						);
						if (rollbackStatus.state !== "ready") {
							throw new Error(
								rollbackStatus.message || "Rollback did not become ready",
							);
						}
						await dependencies.stateMachine.transition(
							release.releaseId,
							"rolled_back",
							{ imageRef: rollbackImageRef },
						);
						await recordReleaseTelemetryBestEffort(() =>
							dependencies.telemetrySink.record({
								type: "rollback.completed",
								deploymentId: deployment.deploymentId,
								imageRef: rollbackImageRef,
							}),
						);
					} catch (rollbackError) {
						await dependencies.stateMachine.fail(
							release.releaseId,
							rollbackError,
						);
					}
				} else {
					await dependencies.stateMachine.fail(release.releaseId, error);
				}
				throw error;
			} finally {
				clearInterval(heartbeat);
				await recordReleaseTelemetryBestEffort(() =>
					dependencies.telemetrySink.flush(),
				);
			}
		},
	};
};
