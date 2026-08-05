import type { Release } from "@dokploy/server/db/schema";
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
} as Release;

const readyHealth: RuntimeHealthResult = {
	passed: true,
	latencyMs: 20,
	statusCode: 200,
	checkedAt: new Date(0).toISOString(),
};

const createHarness = (health: RuntimeHealthResult = readyHealth) => {
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
	const transition = vi.fn(async (_releaseId, state) => ({
		...release,
		state,
	}));
	const stateMachine: ReleaseStateMachine = {
		create: vi.fn(async () => release),
		transition,
		heartbeat: vi.fn(async () => undefined),
		attachArtifact: vi.fn(async () => ({
			...release,
			artifactId: "artifact-1",
		})),
		setPreviousImageRef: vi.fn(async () => undefined),
		recordHealth: vi.fn(async () => undefined),
		fail: vi.fn(
			async (): Promise<Release> => ({
				...release,
				state: "failed",
			}),
		),
		get: vi.fn(async () => release),
		getByDeployment: vi.fn(async () => release),
		getEvents: vi.fn(async () => []),
		reconcileStale: vi.fn(async () => 0),
	};
	const sourcePreparer: SourcePreparer = {
		prepare: vi.fn(async () => ({
			command: "railpack build",
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
			expect.objectContaining({ command: "railpack build" }),
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
