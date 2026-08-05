import type { DeploymentJob } from "../queues/queue-types";
import {
	listDeploymentWorkflows,
	signalDeploymentCancellation,
	startDeploymentWorkflow,
} from "./client";
import { isTemporalDeploymentJob } from "./types";

export type TemporalQueueJob = {
	id: string;
	name: string;
	data: DeploymentJob;
	timestamp: number;
	getState: () => Promise<"waiting" | "active">;
	remove: () => Promise<void>;
};

export class TemporalDeploymentQueue {
	async add(
		name: string,
		data: DeploymentJob,
		opts: Record<string, unknown> = {},
	) {
		if (!isTemporalDeploymentJob(data)) {
			throw new Error("Temporal queue accepts managed application jobs only");
		}
		const requestedId =
			typeof opts.jobId === "string" && opts.jobId.trim()
				? opts.jobId.trim()
				: undefined;
		const started = await startDeploymentWorkflow(data, requestedId);
		const job: TemporalQueueJob = {
			id: started.id,
			name,
			data,
			timestamp: Date.now(),
			getState: async () => "active",
			remove: async () => signalDeploymentCancellation(started.id),
		};
		return { id: job.id };
	}

	async getJobs() {
		return (await listDeploymentWorkflows()).map<TemporalQueueJob>(
			(execution) => ({
				id: execution.workflowId,
				name: "deployments",
				data: execution.job,
				timestamp: execution.startTime.getTime(),
				getState: async () => "active",
				remove: async () => signalDeploymentCancellation(execution.workflowId),
			}),
		);
	}

	async removeWaiting(
		predicate: (data: DeploymentJob) => boolean,
		options: { waitForCompletion?: boolean } = {},
	) {
		const workflows = await listDeploymentWorkflows();
		const matches = workflows.filter((workflow) => predicate(workflow.job));
		const results = await Promise.allSettled(
			matches.map((workflow) =>
				signalDeploymentCancellation(workflow.workflowId, options),
			),
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (failures.length > 0) {
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"One or more Temporal deployment cancellations failed",
			);
		}
		return matches.length;
	}

	async clearWaiting() {
		return this.removeWaiting(() => true);
	}

	on() {}
	async run() {}
	async close() {}
}
