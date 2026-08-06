import { createHash } from "node:crypto";
import type { DeploymentJob } from "../queues/queue-types";

export type TemporalDeploymentJob = Exclude<
	DeploymentJob,
	{ applicationType: "compose" }
>;

export type DeploymentWorkflowInput = {
	workflowId: string;
	idempotencyKey: string;
	job: TemporalDeploymentJob;
};

export type DeploymentWorkflowResult = {
	workflowId: string;
	status: "completed" | "cancelled";
};

export const isTemporalDeploymentJob = (
	job: unknown,
): job is TemporalDeploymentJob => {
	if (!job || typeof job !== "object") return false;
	const candidate = job as Record<string, unknown>;
	if (
		(candidate.applicationType !== "application" &&
			candidate.applicationType !== "application-preview") ||
		typeof candidate.applicationId !== "string" ||
		!candidate.applicationId ||
		typeof candidate.titleLog !== "string" ||
		typeof candidate.descriptionLog !== "string" ||
		(candidate.type !== "deploy" && candidate.type !== "redeploy")
	) {
		return false;
	}
	return (
		candidate.applicationType !== "application-preview" ||
		(typeof candidate.previewDeploymentId === "string" &&
			Boolean(candidate.previewDeploymentId))
	);
};

export const temporalDeploymentMemo = (
	job: TemporalDeploymentJob,
): TemporalDeploymentJob =>
	job.applicationType === "application-preview"
		? {
				applicationId: job.applicationId,
				titleLog: job.titleLog,
				descriptionLog: job.descriptionLog,
				type: job.type,
				applicationType: job.applicationType,
				previewDeploymentId: job.previewDeploymentId,
				...(job.gitDeliveryTargetId
					? { gitDeliveryTargetId: job.gitDeliveryTargetId }
					: {}),
				...(job.sourceBranch ? { sourceBranch: job.sourceBranch } : {}),
				server: false,
			}
		: {
				applicationId: job.applicationId,
				titleLog: job.titleLog,
				descriptionLog: job.descriptionLog,
				type: job.type,
				applicationType: job.applicationType,
				...(job.gitDeliveryTargetId
					? { gitDeliveryTargetId: job.gitDeliveryTargetId }
					: {}),
				...(job.sourceBranch ? { sourceBranch: job.sourceBranch } : {}),
				server: false,
			};

const workflowPart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.slice(0, 120);

export const deploymentWorkflowId = (
	job: TemporalDeploymentJob,
	idempotencyKey: string,
) => {
	const serviceId = job.applicationId;
	const preview =
		job.applicationType === "application-preview"
			? `-${workflowPart(job.previewDeploymentId)}`
			: "";
	const idempotencyDigest = createHash("sha256")
		.update(idempotencyKey)
		.digest("hex")
		.slice(0, 32);
	return `vlyv-release-${workflowPart(serviceId)}${preview}-${idempotencyDigest}`;
};
