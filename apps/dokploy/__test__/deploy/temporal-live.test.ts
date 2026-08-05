import path from "node:path";
import { Context, heartbeat } from "@temporalio/activity";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	closeTemporalClient,
	getTemporalClient,
	signalDeploymentCancellation,
	startDeploymentWorkflow,
} from "@/server/temporal/client";
import type { DeploymentWorkflowInput } from "@/server/temporal/types";

const describeLive =
	process.env.TEMPORAL_INTEGRATION_TEST === "true" ? describe : describe.skip;

const applicationJob: DeploymentJob = {
	applicationId: `temporal-live-application-${Date.now()}`,
	titleLog: "Temporal live smoke test",
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
};

describeLive("Temporal live workflow", () => {
	let connection: NativeConnection;
	let worker: Worker;
	let workerRun: Promise<void>;
	let executeCount = 0;
	let cancellationCount = 0;
	let releaseBlocked = false;
	let activityStartedResolve: (() => void) | undefined;

	beforeAll(async () => {
		process.env.TEMPORAL_ENABLED = "true";
		process.env.TEMPORAL_ADDRESS ||= "localhost:7233";
		process.env.TEMPORAL_NAMESPACE ||= "default";
		process.env.TEMPORAL_TASK_QUEUE = `vlyv-live-${Date.now()}`;
		connection = await NativeConnection.connect({
			address: process.env.TEMPORAL_ADDRESS,
		});
		worker = await Worker.create({
			connection,
			namespace: process.env.TEMPORAL_NAMESPACE,
			taskQueue: process.env.TEMPORAL_TASK_QUEUE,
			workflowsPath: path.resolve(
				import.meta.dirname,
				"../../server/temporal/workflows.ts",
			),
			activities: {
				executeDeploymentJob: async (_input: DeploymentWorkflowInput) => {
					executeCount += 1;
					activityStartedResolve?.();
					if (releaseBlocked) {
						const timer = setInterval(() => heartbeat("blocked"), 100);
						try {
							await Context.current().cancelled;
						} finally {
							clearInterval(timer);
						}
					}
					return true;
				},
				cancelDeploymentJob: async (_input: DeploymentWorkflowInput) => {
					cancellationCount += 1;
					return true;
				},
			},
		});
		workerRun = worker.run();
	}, 60_000);

	afterAll(async () => {
		worker?.shutdown();
		await workerRun;
		await connection?.close();
		await closeTemporalClient();
	}, 60_000);

	it("deduplicates one delivery into one durable execution", async () => {
		const first = await startDeploymentWorkflow(
			applicationJob,
			"delivery-live-1",
		);
		const duplicate = await startDeploymentWorkflow(
			applicationJob,
			"delivery-live-1",
		);
		const result = await (await getTemporalClient()).workflow
			.getHandle(first.id)
			.result();

		expect(duplicate.id).toBe(first.id);
		expect(result).toEqual({ workflowId: first.id, status: "completed" });
		expect(executeCount).toBe(1);
	}, 60_000);

	it("cancels an activity and runs cleanup exactly once", async () => {
		releaseBlocked = true;
		const activityStarted = new Promise<void>((resolve) => {
			activityStartedResolve = resolve;
		});
		const started = await startDeploymentWorkflow(
			applicationJob,
			"delivery-live-cancel",
		);
		await activityStarted;

		await signalDeploymentCancellation(started.id, {
			waitForCompletion: true,
		});
		const result = await (await getTemporalClient()).workflow
			.getHandle(started.id)
			.result();

		expect(result).toEqual({ workflowId: started.id, status: "cancelled" });
		expect(cancellationCount).toBe(1);
	}, 60_000);
});
