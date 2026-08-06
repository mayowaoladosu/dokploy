import { gitDeliveryReportValues } from "@dokploy/server/services/git-delivery-status";
import { describe, expect, it } from "vitest";

describe("Git delivery provider status translation", () => {
	it("reports pending and running releases as in-progress checks", () => {
		expect(gitDeliveryReportValues("enqueued")).toMatchObject({
			state: "pending",
			checkStatus: "in_progress",
			conclusion: undefined,
		});
		expect(gitDeliveryReportValues("running")).toMatchObject({
			state: "pending",
			checkStatus: "in_progress",
		});
	});

	it("completes successful checks and commit statuses", () => {
		expect(gitDeliveryReportValues("succeeded")).toEqual({
			state: "success",
			checkStatus: "completed",
			conclusion: "success",
			label: "Deployment succeeded",
		});
	});

	it("distinguishes failed and cancelled terminal releases", () => {
		expect(gitDeliveryReportValues("failed")).toMatchObject({
			state: "failure",
			checkStatus: "completed",
			conclusion: "failure",
		});
		expect(gitDeliveryReportValues("cancelled")).toMatchObject({
			state: "error",
			checkStatus: "completed",
			conclusion: "cancelled",
		});
	});
});
