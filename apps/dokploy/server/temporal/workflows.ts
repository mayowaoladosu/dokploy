import {
	ActivityCancellationType,
	CancellationScope,
	defineSignal,
	isCancellation,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
	DeploymentWorkflowInput,
	DeploymentWorkflowResult,
} from "./types";

const { executeDeploymentJob } = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 hours",
	heartbeatTimeout: "90 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		initialInterval: "2 seconds",
		backoffCoefficient: 2,
		maximumInterval: "30 seconds",
		maximumAttempts: 240,
		nonRetryableErrorTypes: [
			"TRPCError",
			"SupplyChainPolicyError",
			"TerminalReleaseFailure",
		],
	},
});

const { cancelDeploymentJob } = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "90 seconds",
	retry: {
		initialInterval: "2 seconds",
		backoffCoefficient: 2,
		maximumInterval: "15 seconds",
		maximumAttempts: 2,
		nonRetryableErrorTypes: ["TRPCError", "TerminalReleaseFailure"],
	},
});

export const cancelDeploymentSignal = defineSignal("cancelDeployment");

/**
 * Durable workflow shell around the DB-backed release orchestrator. The
 * activity heartbeats and the release state machine make retries resumable;
 * workflow history contains IDs and user-visible labels only, never secrets.
 */
export async function deploymentWorkflow(
	input: DeploymentWorkflowInput,
): Promise<DeploymentWorkflowResult> {
	let cancellationRequested = false;
	const executionScope = new CancellationScope();
	setHandler(cancelDeploymentSignal, () => {
		cancellationRequested = true;
		executionScope.cancel();
	});

	try {
		await executionScope.run(() => executeDeploymentJob(input));
		return { workflowId: input.workflowId, status: "completed" };
	} catch (error) {
		if (isCancellation(error) || cancellationRequested) {
			const cancelled = await CancellationScope.nonCancellable(() =>
				cancelDeploymentJob(input),
			);
			return {
				workflowId: input.workflowId,
				status: cancelled ? "cancelled" : "completed",
			};
		}
		throw error;
	}
}
