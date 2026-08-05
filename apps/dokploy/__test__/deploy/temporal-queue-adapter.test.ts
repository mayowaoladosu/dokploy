import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { TemporalDeploymentQueue } from "@/server/temporal/queue-adapter";

const {
	listDeploymentWorkflows,
	signalDeploymentCancellation,
	startDeploymentWorkflow,
} = vi.hoisted(() => ({
	listDeploymentWorkflows: vi.fn(),
	signalDeploymentCancellation: vi.fn(),
	startDeploymentWorkflow: vi.fn(),
}));

vi.mock("@/server/temporal/client", () => ({
	listDeploymentWorkflows,
	signalDeploymentCancellation,
	startDeploymentWorkflow,
}));

const applicationJob: DeploymentJob = {
	applicationId: "application-1",
	titleLog: "Deploy",
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
};

describe("Temporal deployment queue adapter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		startDeploymentWorkflow.mockResolvedValue({ id: "workflow-1" });
		listDeploymentWorkflows.mockResolvedValue([
			{
				workflowId: "workflow-1",
				runId: "run-1",
				startTime: new Date(0),
				job: applicationJob,
			},
		]);
		signalDeploymentCancellation.mockResolvedValue(undefined);
	});

	it("passes explicit idempotency keys to Temporal", async () => {
		const queue = new TemporalDeploymentQueue();
		const result = await queue.add("deployments", applicationJob, {
			jobId: "delivery-123",
		});

		expect(result).toEqual({ id: "workflow-1" });
		expect(startDeploymentWorkflow).toHaveBeenCalledWith(
			applicationJob,
			"delivery-123",
		);
		expect(await queue.getJobs()).toMatchObject([
			{ id: "workflow-1", data: applicationJob, timestamp: 0 },
		]);
	});

	it("cancels matching workflows discovered through durable visibility", async () => {
		const queue = new TemporalDeploymentQueue();

		const removed = await queue.removeWaiting(
			(job) =>
				job.applicationType !== "compose" &&
				job.applicationId === applicationJob.applicationId,
		);

		expect(removed).toBe(1);
		expect(signalDeploymentCancellation).toHaveBeenCalledWith("workflow-1", {});
	});

	it("requests acknowledgement before destructive cleanup", async () => {
		const queue = new TemporalDeploymentQueue();

		await queue.removeWaiting(() => true, { waitForCompletion: true });

		expect(signalDeploymentCancellation).toHaveBeenCalledWith("workflow-1", {
			waitForCompletion: true,
		});
	});

	it("rejects compose jobs rather than bypassing managed isolation", async () => {
		const queue = new TemporalDeploymentQueue();
		await expect(
			queue.add("deployments", {
				composeId: "compose-1",
				titleLog: "Deploy",
				descriptionLog: "",
				type: "deploy",
				applicationType: "compose",
			}),
		).rejects.toThrow("managed application jobs only");
	});
});
