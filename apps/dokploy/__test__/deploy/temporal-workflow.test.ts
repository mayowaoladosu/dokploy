import { describe, expect, it } from "vitest";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	deploymentWorkflowId,
	isTemporalDeploymentJob,
	temporalDeploymentMemo,
} from "@/server/temporal/types";

const applicationJob: DeploymentJob = {
	applicationId: "application-1",
	titleLog: "Deploy",
	descriptionLog: "",
	type: "deploy",
	applicationType: "application",
};

describe("Temporal deployment workflow identity", () => {
	it("creates deterministic idempotent workflow IDs", () => {
		expect(deploymentWorkflowId(applicationJob, "delivery-123")).toBe(
			deploymentWorkflowId(applicationJob, "delivery-123"),
		);
		expect(deploymentWorkflowId(applicationJob, "delivery-123")).not.toBe(
			deploymentWorkflowId(applicationJob, "delivery-456"),
		);
	});

	it("includes preview identity to avoid production collisions", () => {
		const previewJob: DeploymentJob = {
			...applicationJob,
			applicationType: "application-preview",
			previewDeploymentId: "preview-42",
		};
		expect(deploymentWorkflowId(previewJob, "delivery-123")).toContain(
			"preview-42",
		);
	});

	it("accepts applications and rejects compose workloads", () => {
		expect(isTemporalDeploymentJob(applicationJob)).toBe(true);
		expect(
			isTemporalDeploymentJob({
				composeId: "compose-1",
				titleLog: "Deploy",
				descriptionLog: "",
				type: "deploy",
				applicationType: "compose",
			}),
		).toBe(false);
		expect(isTemporalDeploymentJob({ applicationType: "application" })).toBe(
			false,
		);
	});

	it("omits server infrastructure from durable visibility metadata", () => {
		const memo = temporalDeploymentMemo({
			...applicationJob,
			server: true,
			serverId: "private-server-1",
		});

		expect(memo).not.toHaveProperty("serverId");
		expect(memo.server).toBe(false);
	});
});
