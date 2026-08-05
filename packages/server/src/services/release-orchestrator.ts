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
		signal?: AbortSignal;
	}): Promise<ReleaseExecutionResult>;
	remove(input: { application: ReleaseApplication }): Promise<void>;
	interrupt(input: {
		application: ReleaseApplication;
		deploymentId: string;
	}): Promise<void>;
	cancel(input: {
		application: ReleaseApplication;
		deploymentId: string;
	}): Promise<"cancelled" | "ready" | "failed" | "rolled_back">;
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
		interrupt: async ({ application, deploymentId }) => {
			await dependencies.buildExecutor.cancel({
				application,
				deploymentId,
				buildServerId:
					application.buildServerId || application.serverId || null,
			});
		},
		cancel: async ({ application, deploymentId }) => {
			let release =
				await dependencies.stateMachine.getByDeployment(deploymentId);
			if (
				release?.state === "ready" ||
				release?.state === "failed" ||
				release?.state === "rolled_back"
			) {
				return release.state;
			}
			let interruptedState:
				| Parameters<ReleaseStateMachine["transition"]>[1]
				| undefined = release?.state;
			if (release?.state === "cancelled") {
				const events = await dependencies.stateMachine.getEvents(
					release.releaseId,
				);
				const cancellationEvent = [...events]
					.reverse()
					.find((event) => event.toState === "cancelled");
				interruptedState = cancellationEvent?.fromState ?? interruptedState;
			}
			if (
				release &&
				release.state !== "cancelled" &&
				release.state !== "rolling_back"
			) {
				release = await dependencies.stateMachine.transition(
					release.releaseId,
					"cancelled",
					{ reason: "Release cancelled" },
				);
			}

			const cleanupOperations: Array<() => Promise<unknown>> = [
				() =>
					dependencies.buildExecutor.cancel({
						application,
						deploymentId,
						buildServerId:
							application.buildServerId || application.serverId || null,
					}),
			];
			const runtimeMayHaveChanged =
				interruptedState === "scheduling" ||
				interruptedState === "verifying" ||
				interruptedState === "rolling_back" ||
				interruptedState === "cancelled";
			if (release && runtimeMayHaveChanged) {
				if (release.previousImageRef) {
					const previousImageRef = release.previousImageRef;
					cleanupOperations.push(async () => {
						const status = await dependencies.runtimeScheduler.rollback({
							application,
							imageRef: previousImageRef,
						});
						if (status.state !== "ready") {
							throw new Error(
								status.message ||
									"Cancelled release rollback did not become ready",
							);
						}
					});
				} else {
					cleanupOperations.push(
						() => dependencies.edgeRouter.withdraw({ application }),
						() => dependencies.runtimeScheduler.remove({ application }),
					);
				}
			}
			const cleanupResults = await Promise.allSettled(
				cleanupOperations.map((operation) => operation()),
			);
			const cleanupFailure = cleanupResults.find(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			if (cleanupFailure) throw cleanupFailure.reason;
			if (release?.state === "rolling_back") {
				await dependencies.stateMachine.transition(
					release.releaseId,
					"rolled_back",
					{ reason: "Release cancelled during rollback" },
				);
			}
			return "cancelled";
		},
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
		execute: async ({ application, deployment, intent, signal }) => {
			const organizationId = application.environment.project.organizationId;
			let release = await dependencies.stateMachine.create({
				deploymentId: deployment.deploymentId,
				applicationId: application.applicationId,
				runtimeProvider: dependencies.runtimeScheduler.provider,
				metadata: {
					buildExecutor: dependencies.buildExecutor.name,
					buildIsolation: dependencies.buildExecutor.isolation,
				},
			});
			let artifact = await dependencies.stateMachine.getArtifact(
				release.releaseId,
			);
			const recoveredHealth = (): RuntimeHealthResult => ({
				passed: true,
				latencyMs: 0,
				checkedAt: new Date().toISOString(),
			});
			if (release.state === "ready" && artifact) {
				return {
					releaseId: release.releaseId,
					artifact,
					health: recoveredHealth(),
				};
			}
			if (
				release.state === "failed" ||
				release.state === "rolled_back" ||
				release.state === "cancelled"
			) {
				throw new Error(
					release.errorMessage || `Release is already ${release.state}`,
				);
			}
			signal?.throwIfAborted();
			await dependencies.usageMeter.assertBuildAllowed(organizationId);
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

			let runtimeMutationStarted = [
				"scheduling",
				"verifying",
				"rolling_back",
			].includes(release.state);
			let edgePublicationStarted = release.state === "verifying";
			let previousImageRef = release.previousImageRef;
			const transition = async (
				state: Parameters<ReleaseStateMachine["transition"]>[1],
				details?: Record<string, unknown>,
			) => {
				release = await dependencies.stateMachine.transition(
					release.releaseId,
					state,
					details,
				);
			};
			try {
				signal?.throwIfAborted();
				if (release.state === "queued") await transition("preparing");
				if (
					(release.state === "preparing" || release.state === "building") &&
					previousImageRef === null
				) {
					previousImageRef =
						await dependencies.runtimeScheduler.getCurrentImage(application);
					await dependencies.stateMachine.setPreviousImageRef(
						release.releaseId,
						previousImageRef,
					);
				}
				if (release.state === "preparing") await transition("building");

				artifact ??= await dependencies.stateMachine.getArtifact(
					release.releaseId,
				);
				if (!artifact && release.state === "building") {
					const prepared = await dependencies.sourcePreparer.prepare({
						application,
						intent,
						workspace:
							dependencies.buildExecutor.isolation === "ephemeral"
								? "fresh"
								: "persistent",
					});
					artifact = await dependencies.buildExecutor.execute({
						application,
						deploymentId: deployment.deploymentId,
						sourceCommand: prepared.sourceCommand,
						buildCommand: prepared.buildCommand,
						logPath: deployment.logPath,
						buildServerId:
							application.buildServerId || application.serverId || null,
					});
					signal?.throwIfAborted();
					await recordReleaseTelemetryBestEffort(() =>
						dependencies.telemetrySink.record({
							type: "build.completed",
							deploymentId: deployment.deploymentId,
							durationMs: artifact?.durationMs ?? 0,
							imageSizeBytes: artifact?.imageSizeBytes ?? null,
						}),
					);
					await persistWithRetry(() =>
						dependencies.usageMeter.recordBuild({
							organizationId,
							projectId: application.environment.project.projectId,
							environmentId: application.environmentId,
							applicationId: application.applicationId,
							deploymentId: deployment.deploymentId,
							durationMs: artifact?.durationMs ?? 0,
							imageSizeBytes: artifact?.imageSizeBytes ?? null,
						}),
					);
					await persistWithRetry(() =>
						dependencies.stateMachine.attachArtifact(
							release.releaseId,
							artifact as BuildExecutionArtifact,
						),
					);
				}
				if (!artifact) throw new Error("Release artifact is unavailable");
				if (release.state === "building") {
					await transition("artifact_ready", {
						imageRef: artifact.imageRef,
						imageDigest: artifact.imageDigest,
					});
				}
				if (release.state === "artifact_ready") await transition("scheduling");
				if (release.state === "scheduling") {
					runtimeMutationStarted = true;
					const runtimeStartedAt = Date.now();
					await dependencies.runtimeScheduler.schedule({
						application,
						artifact,
					});
					signal?.throwIfAborted();
					const readinessDurationMs = Date.now() - runtimeStartedAt;
					await recordReleaseTelemetryBestEffort(() =>
						dependencies.telemetrySink.record({
							type: "runtime.ready",
							deploymentId: deployment.deploymentId,
							runtimeDurationMs: readinessDurationMs,
							readinessDurationMs,
						}),
					);
					await transition("verifying");
				}
				if (release.state === "verifying") {
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
					signal?.throwIfAborted();
					await dependencies.stateMachine.recordHealth(
						release.releaseId,
						health,
					);
					await recordReleaseTelemetryBestEffort(() =>
						dependencies.telemetrySink.record({
							type: "health.completed",
							deploymentId: deployment.deploymentId,
							result: health,
						}),
					);
					if (!health.passed) {
						throw new Error(
							health.error || "Runtime health verification failed",
						);
					}
					await transition("ready", { imageRef: artifact.imageRef });
					return { releaseId: release.releaseId, artifact, health };
				}
				throw new Error(`Release cannot resume from ${release.state}`);
			} catch (error) {
				release = await dependencies.stateMachine.get(release.releaseId);
				if (
					signal?.aborted &&
					release.state !== "cancelled" &&
					release.state !== "ready" &&
					release.state !== "failed" &&
					release.state !== "rolled_back" &&
					release.state !== "rolling_back"
				) {
					await transition("cancelled", {
						reason: "Release activity cancelled",
					});
					throw error;
				}
				if (release.state === "cancelled") throw error;
				if (edgePublicationStarted && !previousImageRef) {
					await dependencies.edgeRouter
						.withdraw({ application })
						.catch((withdrawError) =>
							console.error(
								"Failed to withdraw preview edge route",
								withdrawError,
							),
						);
				}
				if (
					(runtimeMutationStarted || release.state === "rolling_back") &&
					previousImageRef
				) {
					const rollbackImageRef = previousImageRef;
					try {
						if (release.state !== "rolling_back") {
							await transition("rolling_back", {
								reason: error instanceof Error ? error.message : String(error),
								imageRef: rollbackImageRef,
							});
						}
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
						await transition("rolled_back", { imageRef: rollbackImageRef });
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
				} else if (
					release.state !== "failed" &&
					release.state !== "rolled_back"
				) {
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
