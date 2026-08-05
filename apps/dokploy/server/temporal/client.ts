import {
	Client,
	Connection,
	WorkflowExecutionAlreadyStartedError,
	WorkflowIdConflictPolicy,
	WorkflowIdReusePolicy,
} from "@temporalio/client";
import { nanoid } from "nanoid";
import type { DeploymentJob } from "../queues/queue-types";
import { assertTemporalConfiguration } from "./config";
import {
	type DeploymentWorkflowInput,
	deploymentWorkflowId,
	isTemporalDeploymentJob,
	temporalDeploymentMemo,
} from "./types";
import { cancelDeploymentSignal, deploymentWorkflow } from "./workflows";

let clientPromise: Promise<Client> | null = null;

const createClient = async () => {
	const config = assertTemporalConfiguration();
	if (!config.enabled) {
		throw new Error(
			"Managed deployments require TEMPORAL_ENABLED=true and a reachable Temporal service",
		);
	}
	const connection = await Connection.connect({
		address: config.address,
		tls: config.tls,
		apiKey: config.apiKey,
	});
	return new Client({ connection, namespace: config.namespace });
};

export const getTemporalClient = () => {
	clientPromise ??= createClient().catch((error) => {
		clientPromise = null;
		throw error;
	});
	return clientPromise;
};

export const startDeploymentWorkflow = async (
	job: DeploymentJob,
	idempotencyKey = nanoid(),
) => {
	if (!isTemporalDeploymentJob(job)) {
		throw new Error("Compose deployments are not supported by Temporal");
	}
	const normalizedIdempotencyKey = idempotencyKey.trim();
	if (!normalizedIdempotencyKey || normalizedIdempotencyKey.length > 256) {
		throw new Error(
			"Deployment idempotency keys must contain 1 to 256 characters",
		);
	}
	const config = assertTemporalConfiguration();
	const workflowId = deploymentWorkflowId(job, normalizedIdempotencyKey);
	const workflowJob = temporalDeploymentMemo(job);
	const input: DeploymentWorkflowInput = {
		workflowId,
		idempotencyKey: normalizedIdempotencyKey,
		job: workflowJob,
	};
	const client = await getTemporalClient();
	try {
		const handle = await client.workflow.start(deploymentWorkflow, {
			workflowId,
			taskQueue: config.taskQueue,
			args: [input],
			workflowExecutionTimeout: "3 hours",
			workflowRunTimeout: "3 hours",
			workflowTaskTimeout: "10 seconds",
			workflowIdReusePolicy:
				WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
			workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
			memo: {
				job: workflowJob,
				idempotencyKey: normalizedIdempotencyKey,
			},
		});
		return { id: workflowId, runId: handle.firstExecutionRunId };
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			return { id: workflowId };
		}
		throw error;
	}
};

export const signalDeploymentCancellation = async (
	workflowId: string,
	options: { waitForCompletion?: boolean } = {},
) => {
	const client = await getTemporalClient();
	const handle = client.workflow.getHandle(workflowId);
	try {
		await handle.signal(cancelDeploymentSignal);
	} catch (error) {
		if (error instanceof Error && error.name === "WorkflowNotFoundError")
			return;
		throw error;
	}
	if (!options.waitForCompletion) return;
	const { cancellationWaitMs } = assertTemporalConfiguration();
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			handle.result(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`Timed out waiting for workflow ${workflowId} cancellation`,
							),
						),
					cancellationWaitMs,
				);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
};

export const listDeploymentWorkflows = async () => {
	const client = await getTemporalClient();
	const executions = [];
	for await (const execution of client.workflow.list({
		query:
			'WorkflowType = "deploymentWorkflow" AND ExecutionStatus = "Running"',
	})) {
		const job = execution.memo?.job;
		if (!isTemporalDeploymentJob(job)) continue;
		executions.push({
			workflowId: execution.workflowId,
			runId: execution.runId,
			startTime: execution.startTime,
			job,
		});
	}
	return executions;
};

export const closeTemporalClient = async () => {
	if (!clientPromise) return;
	const client = await clientPromise;
	await client.connection.close();
	clientPromise = null;
};
