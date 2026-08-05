import {
	createPlatformReleasePlan,
	createReleaseStateMachine,
	deployApplication,
	deployPreviewApplication,
	findApplicationById,
	findDeploymentById,
	rebuildApplication,
	rebuildPreviewApplication,
	updateApplicationStatus,
	updateDeploymentStatus,
	updatePreviewDeployment,
} from "@dokploy/server";
import {
	ApplicationFailure,
	activityInfo,
	Context,
} from "@temporalio/activity";
import type { DeploymentWorkflowInput } from "./types";

const heartbeatTimer = (phase: string) => {
	const context = Context.current();
	const timer = setInterval(() => context.heartbeat({ phase }), 15_000);
	timer.unref?.();
	return () => clearInterval(timer);
};

const executeJob = async (
	input: DeploymentWorkflowInput,
	signal: AbortSignal,
) => {
	const { job } = input;
	if (job.applicationType === "application-preview") {
		await updatePreviewDeployment(job.previewDeploymentId, {
			previewStatus: "running",
		});
		if (job.type === "redeploy") {
			return rebuildPreviewApplication({
				applicationId: job.applicationId,
				previewDeploymentId: job.previewDeploymentId,
				titleLog: job.titleLog,
				descriptionLog: job.descriptionLog,
				deploymentId: input.workflowId,
				signal,
			});
		}
		return deployPreviewApplication({
			applicationId: job.applicationId,
			previewDeploymentId: job.previewDeploymentId,
			titleLog: job.titleLog,
			descriptionLog: job.descriptionLog,
			deploymentId: input.workflowId,
			signal,
		});
	}

	await updateApplicationStatus(job.applicationId, "running");
	if (job.type === "redeploy") {
		return rebuildApplication({
			applicationId: job.applicationId,
			titleLog: job.titleLog,
			descriptionLog: job.descriptionLog,
			deploymentId: input.workflowId,
			signal,
		});
	}
	return deployApplication({
		applicationId: job.applicationId,
		titleLog: job.titleLog,
		descriptionLog: job.descriptionLog,
		deploymentId: input.workflowId,
		signal,
	});
};

const interruptDeploymentBuild = async (input: DeploymentWorkflowInput) => {
	const application = await findApplicationById(input.job.applicationId);
	const releasePlan = await createPlatformReleasePlan(application);
	await releasePlan.orchestrator.interrupt({
		application,
		deploymentId: input.workflowId,
	});
};

const reconcileCompletedDeployment = async (
	input: DeploymentWorkflowInput,
	status: "done" | "error",
) => {
	const deployment = await findDeploymentById(input.workflowId).catch(
		() => null,
	);
	if (deployment) await updateDeploymentStatus(deployment.deploymentId, status);
	await updateApplicationStatus(input.job.applicationId, status);
	if (input.job.applicationType === "application-preview") {
		await updatePreviewDeployment(input.job.previewDeploymentId, {
			previewStatus: status,
		});
	}
};

/**
 * Idempotency is anchored by the deterministic workflow ID plus the release
 * table's one-release-per-deployment constraint. If an activity retry observes
 * the application already healthy after a completed attempt, it returns rather
 * than starting duplicate work.
 */
export const executeDeploymentJob = async (input: DeploymentWorkflowInput) => {
	const context = Context.current();
	const stopHeartbeat = heartbeatTimer("release-running");
	let interruption: Promise<void> | null = null;
	const interruptBuild = () => {
		interruption ??= interruptDeploymentBuild(input);
	};
	context.cancellationSignal.addEventListener("abort", interruptBuild, {
		once: true,
	});
	try {
		context.heartbeat({ phase: "starting", attempt: activityInfo().attempt });
		const release = await createReleaseStateMachine()
			.getByDeployment(input.workflowId)
			.catch(() => null);
		if (release?.state === "ready") {
			await reconcileCompletedDeployment(input, "done");
			return true;
		}
		if (release?.state === "cancelled") {
			const deployment = await findDeploymentById(input.workflowId).catch(
				() => null,
			);
			if (deployment) {
				await updateDeploymentStatus(deployment.deploymentId, "cancelled");
			}
			await updateApplicationStatus(input.job.applicationId, "idle");
			if (input.job.applicationType === "application-preview") {
				await updatePreviewDeployment(input.job.previewDeploymentId, {
					previewStatus: "idle",
				});
			}
			throw ApplicationFailure.nonRetryable(
				"Release is already cancelled",
				"TerminalReleaseFailure",
			);
		}
		if (release?.state === "failed" || release?.state === "rolled_back") {
			await reconcileCompletedDeployment(input, "error");
			throw ApplicationFailure.nonRetryable(
				release.errorMessage || `Release is already ${release.state}`,
				"TerminalReleaseFailure",
			);
		}
		const existing = await findDeploymentById(input.workflowId).catch(
			() => null,
		);
		if (existing?.status === "done") return true;
		const result = await executeJob(input, context.cancellationSignal);
		context.cancellationSignal.throwIfAborted();
		return result;
	} catch (error) {
		if (context.cancellationSignal.aborted) throw error;
		const release = await createReleaseStateMachine()
			.getByDeployment(input.workflowId)
			.catch(() => null);
		if (
			release?.state === "failed" ||
			release?.state === "rolled_back" ||
			release?.state === "cancelled"
		) {
			throw ApplicationFailure.nonRetryable(
				error instanceof Error ? error.message : String(error),
				"TerminalReleaseFailure",
			);
		}
		throw error;
	} finally {
		context.cancellationSignal.removeEventListener("abort", interruptBuild);
		await (interruption as Promise<void> | null)?.catch((error: unknown) =>
			console.error("Temporal build interruption failed", error),
		);
		stopHeartbeat();
	}
};

export const cancelDeploymentJob = async (input: DeploymentWorkflowInput) => {
	const context = Context.current();
	const stopHeartbeat = heartbeatTimer("release-cancelling");
	try {
		context.heartbeat({ phase: "cancelling", attempt: activityInfo().attempt });
		const application = await findApplicationById(input.job.applicationId);
		const admittedRelease = await createReleaseStateMachine()
			.getByDeployment(input.workflowId)
			.catch(() => null);
		const releasePlan = await createPlatformReleasePlan(application);
		const cancellationOutcome = await releasePlan.orchestrator.cancel({
			application,
			deploymentId: input.workflowId,
		});
		const runningDeployment = await findDeploymentById(input.workflowId).catch(
			() => null,
		);
		if (cancellationOutcome !== "cancelled") {
			const completed = cancellationOutcome === "ready";
			if (runningDeployment) {
				await updateDeploymentStatus(
					runningDeployment.deploymentId,
					completed ? "done" : "error",
				);
			}
			await updateApplicationStatus(
				application.applicationId,
				completed ? "done" : "error",
			);
			if (input.job.applicationType === "application-preview") {
				await updatePreviewDeployment(input.job.previewDeploymentId, {
					previewStatus: completed ? "done" : "error",
				});
			}
			return false;
		}
		if (runningDeployment) {
			await updateDeploymentStatus(runningDeployment.deploymentId, "cancelled");
		}
		if (admittedRelease) {
			await updateApplicationStatus(application.applicationId, "idle");
		}
		if (input.job.applicationType === "application-preview") {
			await updatePreviewDeployment(input.job.previewDeploymentId, {
				previewStatus: "idle",
			});
		}
		return true;
	} finally {
		stopHeartbeat();
	}
};
