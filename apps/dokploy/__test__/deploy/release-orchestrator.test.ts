import type { Release, ReleaseEvent } from "@dokploy/server/db/schema";
import type {
	BuildExecutionArtifact,
	BuildExecutor,
} from "@dokploy/server/services/build-executor";
import type { Deployment } from "@dokploy/server/services/deployment";
import type { EdgeRouter } from "@dokploy/server/services/edge-router";
import { createReleaseOrchestrator } from "@dokploy/server/services/release-orchestrator";
import type { ReleaseStateMachine } from "@dokploy/server/services/release-state-machine";
import type {
	RuntimeHealthResult,
	RuntimeScheduler,
	RuntimeStatus,
} from "@dokploy/server/services/runtime-scheduler";
import type { SourcePreparer } from "@dokploy/server/services/source-preparer";
import type { TelemetrySink } from "@dokploy/server/services/telemetry-sink";
import type { UsageMeter } from "@dokploy/server/services/usage-metering";
import type { ApplicationNested } from "@dokploy/server/utils/builders";
import { describe, expect, it, vi } from "vitest";

const artifact: BuildExecutionArtifact = {
	imageId: "sha256:image",
	imageDigest: "sha256:new",
	imageRef: "registry.example.com/team/app@sha256:new",
	imageSizeBytes: 1_024,
	builder: "railpack",
	executor: "test-executor",
	durationMs: 250,
	metadata: {},
};

const application = {
	applicationId: "application-1",
	appName: "app-1",
	buildServerId: "builder-1",
	serverId: "runtime-1",
	environmentId: "environment-1",
	environment: {
		project: {
			projectId: "project-1",
			organizationId: "organization-1",
		},
	},
} as unknown as ApplicationNested;

const deployment = {
	deploymentId: "deployment-1",
	logPath: "/tmp/deployment-1.log",
} as Deployment;

const release = {
	releaseId: "release-1",
	deploymentId: deployment.deploymentId,
	applicationId: application.applicationId,
	state: "queued",
	stateVersion: 0,
	previousImageRef: null,
} as Release;

const readyHealth: RuntimeHealthResult = {
	passed: true,
	latencyMs: 20,
	statusCode: 200,
	checkedAt: new Date(0).toISOString(),
};

const createHarness = (health: RuntimeHealthResult = readyHealth) => {
	let currentRelease = { ...release };
	let storedArtifact: BuildExecutionArtifact | null = null;
	const events: ReleaseEvent[] = [];
	const buildExecutor: BuildExecutor = {
		name: "test-executor",
		isolation: "ephemeral",
		execute: vi.fn(async () => artifact),
		cancel: vi.fn(async () => undefined),
	};
	const runtimeScheduler: RuntimeScheduler = {
		provider: "test-runtime",
		getCurrentImage: vi.fn(
			async () => "registry.example.com/team/app@sha256:previous",
		),
		schedule: vi.fn(
			async (): Promise<RuntimeStatus> => ({
				provider: "test-runtime",
				imageRef: artifact.imageRef,
				desiredReplicas: 1,
				readyReplicas: 1,
				state: "ready",
			}),
		),
		verifyHealth: vi.fn(async () => health),
		rollback: vi.fn(
			async ({ imageRef }): Promise<RuntimeStatus> => ({
				provider: "test-runtime",
				imageRef,
				desiredReplicas: 1,
				readyReplicas: 1,
				state: "ready",
			}),
		),
		remove: vi.fn(async () => undefined),
	};
	const transition = vi.fn(async (_releaseId, state) => {
		const fromState = currentRelease.state;
		currentRelease = {
			...currentRelease,
			state,
			stateVersion: currentRelease.stateVersion + 1,
		};
		events.push({ fromState, toState: state } as ReleaseEvent);
		return currentRelease;
	});
	const stateMachine: ReleaseStateMachine = {
		create: vi.fn(async () => currentRelease),
		transition,
		heartbeat: vi.fn(async () => undefined),
		attachArtifact: vi.fn(async (_releaseId, value) => {
			storedArtifact = value;
			currentRelease = { ...currentRelease, artifactId: "artifact-1" };
			return currentRelease;
		}),
		setPreviousImageRef: vi.fn(async (_releaseId, imageRef) => {
			currentRelease = { ...currentRelease, previousImageRef: imageRef };
		}),
		recordHealth: vi.fn(async () => undefined),
		getArtifact: vi.fn(async () => storedArtifact),
		fail: vi.fn(async (): Promise<Release> => {
			currentRelease = { ...currentRelease, state: "failed" };
			return currentRelease;
		}),
		get: vi.fn(async () => currentRelease),
		getByDeployment: vi.fn(async () => currentRelease),
		getEvents: vi.fn(async () => events),
		reconcileStale: vi.fn(async () => 0),
	};
	const sourcePreparer: SourcePreparer = {
		prepare: vi.fn(async () => ({
			command: "railpack build",
			sourceCommand: "git clone;",
			buildCommand: "railpack build",
			metadata: {
				sourceType: "git" as const,
				buildType: "railpack" as const,
				cloned: true,
				patchesApplied: true,
			},
		})),
	};
	const edgeRouter: EdgeRouter = {
		provider: "test-edge",
		publish: vi.fn(async () => ({
			provider: "test-edge",
			domains: ["app.example.com"],
			publishedAt: new Date(0).toISOString(),
		})),
		withdraw: vi.fn(async () => undefined),
	};
	const telemetrySink: TelemetrySink = {
		record: vi.fn(async () => undefined),
		flush: vi.fn(async () => undefined),
	};
	const usageMeter: UsageMeter = {
		assertBuildAllowed: vi.fn(async () => undefined),
		recordBuild: vi.fn(async () => undefined),
	};
	const orchestrator = createReleaseOrchestrator({
		buildExecutor,
		runtimeScheduler,
		stateMachine,
		sourcePreparer,
		edgeRouter,
		telemetrySink,
		usageMeter,
		heartbeatIntervalMs: 60_000,
	});

	return {
		orchestrator,
		buildExecutor,
		runtimeScheduler,
		stateMachine,
		sourcePreparer,
		edgeRouter,
		telemetrySink,
		usageMeter,
		transition,
		recoverAt: (
			state: Release["state"],
			options: {
				artifact?: BuildExecutionArtifact | null;
				previousImageRef?: string | null;
			} = {},
		) => {
			currentRelease = {
				...currentRelease,
				state,
				previousImageRef:
					options.previousImageRef ?? currentRelease.previousImageRef,
				artifactId: options.artifact ? "artifact-1" : currentRelease.artifactId,
			};
			if (options.artifact !== undefined) storedArtifact = options.artifact;
		},
	};
};

describe("release orchestrator", () => {
	it("persists artifact and telemetry across the durable release lifecycle", async () => {
		const harness = createHarness();

		const result = await harness.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "deploy" },
		});

		expect(result).toEqual({
			releaseId: release.releaseId,
			artifact,
			health: readyHealth,
		});
		expect(harness.transition.mock.calls.map((call) => call[1])).toEqual([
			"preparing",
			"building",
			"artifact_ready",
			"scheduling",
			"verifying",
			"ready",
		]);
		expect(harness.stateMachine.attachArtifact).toHaveBeenCalledWith(
			release.releaseId,
			artifact,
		);
		expect(harness.sourcePreparer.prepare).toHaveBeenCalledWith({
			application,
			intent: { kind: "deploy" },
			workspace: "fresh",
		});
		expect(harness.buildExecutor.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				sourceCommand: "git clone;",
				buildCommand: "railpack build",
			}),
		);
		expect(harness.telemetrySink.record).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "build.completed",
				deploymentId: deployment.deploymentId,
			}),
		);
		expect(harness.edgeRouter.publish).toHaveBeenCalledWith(
			expect.objectContaining({ application }),
		);
		expect(
			vi.mocked(harness.edgeRouter.publish).mock.invocationCallOrder[0],
		).toBeLessThan(
			vi.mocked(harness.runtimeScheduler.verifyHealth).mock
				.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(harness.telemetrySink.flush).toHaveBeenCalledTimes(1);
		expect(harness.usageMeter.assertBuildAllowed).toHaveBeenCalledWith(
			application.environment.project.organizationId,
		);
		expect(harness.usageMeter.recordBuild).toHaveBeenCalledWith(
			expect.objectContaining({
				deploymentId: deployment.deploymentId,
				durationMs: artifact.durationMs,
				imageSizeBytes: artifact.imageSizeBytes,
			}),
		);
		expect(harness.runtimeScheduler.rollback).not.toHaveBeenCalled();
	});

	it("rolls back to the previous immutable image when health verification fails", async () => {
		const failedHealth: RuntimeHealthResult = {
			passed: false,
			latencyMs: 100,
			statusCode: 503,
			error: "Health endpoint returned HTTP 503",
			checkedAt: new Date(0).toISOString(),
		};
		const harness = createHarness(failedHealth);

		await expect(
			harness.orchestrator.execute({
				application,
				deployment,
				intent: { kind: "deploy" },
			}),
		).rejects.toThrow("Health endpoint returned HTTP 503");

		expect(harness.transition.mock.calls.map((call) => call[1])).toEqual([
			"preparing",
			"building",
			"artifact_ready",
			"scheduling",
			"verifying",
			"rolling_back",
			"rolled_back",
		]);
		expect(harness.runtimeScheduler.rollback).toHaveBeenCalledWith({
			application,
			imageRef: "registry.example.com/team/app@sha256:previous",
		});
		expect(harness.stateMachine.fail).not.toHaveBeenCalled();
		expect(harness.telemetrySink.record).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "health.completed",
				result: failedHealth,
			}),
		);
	});

	it("withdraws a failed preview route", async () => {
		const failedHealth: RuntimeHealthResult = {
			passed: false,
			latencyMs: 100,
			error: "Preview returned HTTP 503",
			checkedAt: new Date(0).toISOString(),
		};
		const harness = createHarness(failedHealth);
		vi.mocked(harness.runtimeScheduler.getCurrentImage).mockResolvedValueOnce(
			null,
		);
		const previewApplication = {
			...application,
			releaseIdentity: "preview-42",
		};

		await expect(
			harness.orchestrator.execute({
				application: previewApplication,
				deployment,
				intent: { kind: "preview-deploy" },
			}),
		).rejects.toThrow("Preview returned HTTP 503");

		expect(harness.edgeRouter.withdraw).toHaveBeenCalledWith({
			application: previewApplication,
		});
	});

	it("removes edge and runtime resources through one lifecycle call", async () => {
		const harness = createHarness();

		await harness.orchestrator.remove({ application });

		expect(harness.edgeRouter.withdraw).toHaveBeenCalledWith({ application });
		expect(harness.runtimeScheduler.remove).toHaveBeenCalledWith({
			application,
		});
	});

	it("fences cancellation and restores the previous runtime", async () => {
		const harness = createHarness();
		harness.recoverAt("scheduling", {
			artifact,
			previousImageRef: "registry.example.com/team/app@sha256:previous",
		});

		await harness.orchestrator.cancel({
			application,
			deploymentId: deployment.deploymentId,
		});

		expect(harness.transition).toHaveBeenCalledWith("release-1", "cancelled", {
			reason: "Release cancelled",
		});
		expect(harness.buildExecutor.cancel).toHaveBeenCalledTimes(1);
		expect(harness.runtimeScheduler.rollback).toHaveBeenCalledWith({
			application,
			imageRef: "registry.example.com/team/app@sha256:previous",
		});
		expect(harness.runtimeScheduler.remove).not.toHaveBeenCalled();
	});

	it("repeats cleanup safely after cancellation acknowledgement loss", async () => {
		const harness = createHarness();
		harness.recoverAt("cancelled", {
			artifact,
			previousImageRef: "registry.example.com/team/app@sha256:previous",
		});

		await harness.orchestrator.cancel({
			application,
			deploymentId: deployment.deploymentId,
		});

		expect(harness.transition).not.toHaveBeenCalled();
		expect(harness.buildExecutor.cancel).toHaveBeenCalledTimes(1);
		expect(harness.runtimeScheduler.rollback).toHaveBeenCalledTimes(1);
	});

	it("removes a partial first release when it is cancelled", async () => {
		const harness = createHarness();
		harness.recoverAt("verifying", { artifact });

		await harness.orchestrator.cancel({
			application,
			deploymentId: deployment.deploymentId,
		});

		expect(harness.edgeRouter.withdraw).toHaveBeenCalledWith({ application });
		expect(harness.runtimeScheduler.remove).toHaveBeenCalledWith({
			application,
		});
		expect(harness.runtimeScheduler.rollback).not.toHaveBeenCalled();
	});

	it("fences an interrupted build without failing or mutating runtime", async () => {
		const harness = createHarness();
		const controller = new AbortController();
		vi.mocked(harness.buildExecutor.execute).mockImplementationOnce(
			async () => {
				controller.abort();
				throw new Error("build interrupted");
			},
		);

		await expect(
			harness.orchestrator.execute({
				application,
				deployment,
				intent: { kind: "deploy" },
				signal: controller.signal,
			}),
		).rejects.toThrow("build interrupted");

		expect(harness.transition.mock.calls.map((call) => call[1])).toEqual([
			"preparing",
			"building",
			"cancelled",
		]);
		expect(harness.stateMachine.fail).not.toHaveBeenCalled();

		expect(
			await harness.orchestrator.cancel({
				application,
				deploymentId: deployment.deploymentId,
			}),
		).toBe("cancelled");
		expect(harness.buildExecutor.cancel).toHaveBeenCalledTimes(1);
		expect(harness.runtimeScheduler.rollback).not.toHaveBeenCalled();
		expect(harness.runtimeScheduler.remove).not.toHaveBeenCalled();
	});

	it("resumes from an artifact checkpoint without rebuilding", async () => {
		const harness = createHarness();
		harness.recoverAt("artifact_ready", {
			artifact,
			previousImageRef: "registry.example.com/team/app@sha256:previous",
		});

		await harness.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "deploy" },
		});

		expect(harness.buildExecutor.execute).not.toHaveBeenCalled();
		expect(harness.runtimeScheduler.schedule).toHaveBeenCalledTimes(1);
		expect(harness.transition.mock.calls.map((call) => call[1])).toEqual([
			"scheduling",
			"verifying",
			"ready",
		]);
	});

	it("re-applies an idempotent schedule after a scheduling crash", async () => {
		const harness = createHarness();
		harness.recoverAt("scheduling", {
			artifact,
			previousImageRef: "registry.example.com/team/app@sha256:previous",
		});

		await harness.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "deploy" },
		});

		expect(harness.buildExecutor.execute).not.toHaveBeenCalled();
		expect(harness.runtimeScheduler.schedule).toHaveBeenCalledTimes(1);
		expect(harness.transition.mock.calls.map((call) => call[1])).toEqual([
			"verifying",
			"ready",
		]);
	});

	it("returns an already-ready release after acknowledgement loss", async () => {
		const harness = createHarness();
		harness.recoverAt("ready", { artifact });

		const result = await harness.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "deploy" },
		});

		expect(result.artifact).toEqual(artifact);
		expect(harness.buildExecutor.execute).not.toHaveBeenCalled();
		expect(harness.runtimeScheduler.schedule).not.toHaveBeenCalled();
		expect(harness.edgeRouter.publish).not.toHaveBeenCalled();
	});

	it("does not tear down a release that won a late cancellation race", async () => {
		const harness = createHarness();
		harness.recoverAt("ready", { artifact });

		await expect(
			harness.orchestrator.cancel({
				application,
				deploymentId: deployment.deploymentId,
			}),
		).resolves.toBe("ready");

		expect(harness.buildExecutor.cancel).not.toHaveBeenCalled();
		expect(harness.runtimeScheduler.rollback).not.toHaveBeenCalled();
		expect(harness.runtimeScheduler.remove).not.toHaveBeenCalled();
	});

	it("retries transient artifact persistence failures", async () => {
		const harness = createHarness();
		vi.mocked(harness.stateMachine.attachArtifact)
			.mockRejectedValueOnce(new Error("database unavailable"))
			.mockResolvedValueOnce({
				...release,
				artifactId: "artifact-1",
			});

		await harness.orchestrator.execute({
			application,
			deployment,
			intent: { kind: "deploy" },
		});

		expect(harness.stateMachine.attachArtifact).toHaveBeenCalledTimes(2);
		expect(harness.transition).toHaveBeenCalledWith(
			release.releaseId,
			"ready",
			{ imageRef: artifact.imageRef },
		);
	});
});
