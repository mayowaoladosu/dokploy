import type { ApplicationNested } from "@dokploy/server/utils/builders";
import {
	type BuildExecutionArtifact,
	type BuildExecutor,
	createShellBuildExecutor,
} from "./build-executor";
import type { Deployment } from "./deployment";
import {
	createDeploymentTelemetry,
	type DeploymentTelemetry,
	recordTelemetryBestEffort,
} from "./deployment-telemetry";
import {
	createReleaseStateMachine,
	type ReleaseStateMachine,
} from "./release-state-machine";
import {
	createSwarmRuntimeScheduler,
	type RuntimeHealthResult,
	type RuntimeScheduler,
} from "./runtime-scheduler";

export type ReleaseExecutionResult = {
	releaseId: string;
	artifact: BuildExecutionArtifact;
	health: RuntimeHealthResult;
};

export interface ReleaseOrchestrator {
	execute(input: {
		application: ApplicationNested;
		deployment: Deployment;
		command: string;
	}): Promise<ReleaseExecutionResult>;
}

export type ReleaseOrchestratorDependencies = {
	buildExecutor: BuildExecutor;
	runtimeScheduler: RuntimeScheduler;
	stateMachine: ReleaseStateMachine;
	telemetry: DeploymentTelemetry;
	heartbeatIntervalMs: number;
};

const persistArtifactWithRetry = async (
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
		telemetry: createDeploymentTelemetry(),
		heartbeatIntervalMs: 30_000,
		...overrides,
	};

	return {
		execute: async ({ application, deployment, command }) => {
			const release = await dependencies.stateMachine.create({
				deploymentId: deployment.deploymentId,
				applicationId: application.applicationId,
				runtimeProvider: dependencies.runtimeScheduler.provider,
				metadata: {
					buildExecutor: dependencies.buildExecutor.name,
					buildIsolation: dependencies.buildExecutor.isolation,
				},
			});
			await recordTelemetryBestEffort(() =>
				dependencies.telemetry.initialize(
					deployment.deploymentId,
					application.applicationId,
				),
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
				const artifact = await dependencies.buildExecutor.execute({
					application,
					deploymentId: deployment.deploymentId,
					command,
					logPath: deployment.logPath,
					buildServerId:
						application.buildServerId || application.serverId || null,
				});
				await recordTelemetryBestEffort(() =>
					dependencies.telemetry.recordBuild(
						deployment.deploymentId,
						artifact.durationMs,
						artifact.imageSizeBytes,
					),
				);
				await persistArtifactWithRetry(() =>
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
				await recordTelemetryBestEffort(() =>
					dependencies.telemetry.recordRuntime(
						deployment.deploymentId,
						readinessDurationMs,
						readinessDurationMs,
					),
				);

				await dependencies.stateMachine.transition(
					release.releaseId,
					"verifying",
				);
				const health = await dependencies.runtimeScheduler.verifyHealth({
					application,
				});
				await dependencies.stateMachine.recordHealth(release.releaseId, health);
				await recordTelemetryBestEffort(() =>
					dependencies.telemetry.recordHealth(deployment.deploymentId, health),
				);
				if (!health.passed) {
					throw new Error(health.error || "Runtime health verification failed");
				}

				await dependencies.stateMachine.transition(release.releaseId, "ready", {
					imageRef: artifact.imageRef,
				});
				return { releaseId: release.releaseId, artifact, health };
			} catch (error) {
				if (runtimeMutationStarted && previousImageRef) {
					try {
						await dependencies.stateMachine.transition(
							release.releaseId,
							"rolling_back",
							{
								reason: error instanceof Error ? error.message : String(error),
								imageRef: previousImageRef,
							},
						);
						const rollbackStatus = await dependencies.runtimeScheduler.rollback(
							{
								application,
								imageRef: previousImageRef,
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
							{ imageRef: previousImageRef },
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
			}
		},
	};
};
