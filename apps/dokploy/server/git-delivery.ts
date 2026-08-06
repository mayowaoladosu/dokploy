import {
	IS_CLOUD,
	listGitDeliveryTargetsDueForEnqueue,
	listGitDeliveryTargetsDueForReport,
	markGitDeliveryTargetEnqueued,
	markGitDeliveryTargetEnqueueFailed,
	markGitDeliveryTargetFinished,
	prepareGitDeliveryTargetForEnqueue,
	reconcileGitDeliveryTargetStates,
	removePreviewDeployment,
	synchronizeGitDeliveryTargetReport,
} from "@dokploy/server";
import type { NextApiRequest } from "next";
import type { DeploymentJob } from "./queues/queue-types";
import { cleanQueuesByPreviewDeployment, myQueue } from "./queues/queueSetup";
import { deploy } from "./utils/deploy";

const maximumWebhookBytes = 2 * 1024 * 1024;

export const readRawJsonWebhook = async (req: NextApiRequest) => {
	if (
		req.body &&
		typeof req.body === "object" &&
		typeof (req as unknown as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] !== "function"
	) {
		const rawBody = Buffer.from(JSON.stringify(req.body), "utf8");
		return { rawBody, body: req.body as Record<string, any> };
	}
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > maximumWebhookBytes) {
			throw new Error("Webhook payload exceeds the platform limit");
		}
		chunks.push(buffer);
	}
	const rawBody = Buffer.concat(chunks);
	let body: unknown;
	try {
		body = JSON.parse(rawBody.toString("utf8"));
	} catch {
		throw new Error("Webhook payload is not valid JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new Error("Webhook payload must be a JSON object");
	}
	req.body = body;
	return { rawBody, body: body as Record<string, any> };
};

const isDeploymentJob = (value: unknown): value is DeploymentJob => {
	if (!value || typeof value !== "object") return false;
	const job = value as Record<string, unknown>;
	if (
		!["application", "application-preview", "compose"].includes(
			String(job.applicationType),
		) ||
		!["deploy", "redeploy"].includes(String(job.type)) ||
		typeof job.titleLog !== "string" ||
		typeof job.descriptionLog !== "string"
	) {
		return false;
	}
	if (job.applicationType === "compose")
		return typeof job.composeId === "string";
	if (typeof job.applicationId !== "string") return false;
	return (
		job.applicationType !== "application-preview" ||
		typeof job.previewDeploymentId === "string"
	);
};

export const enqueueGitDeliveryTarget = async (gitDeliveryTargetId: string) => {
	const target = await prepareGitDeliveryTargetForEnqueue(gitDeliveryTargetId);
	if (!target) return false;
	try {
		if (target.job.kind === "preview_cleanup") {
			await cleanQueuesByPreviewDeployment(target.job.previewDeploymentId, {
				waitForCompletion: true,
			});
			await removePreviewDeployment(target.job.previewDeploymentId).catch(
				(error) => {
					if (
						!(
							error &&
							typeof error === "object" &&
							"code" in error &&
							error.code === "NOT_FOUND"
						)
					) {
						throw error;
					}
				},
			);
			await markGitDeliveryTargetFinished(gitDeliveryTargetId, "succeeded");
			await synchronizeGitDeliveryTargetReport(gitDeliveryTargetId).catch(
				(error) => console.error("Failed to report Git cleanup status", error),
			);
			return true;
		}
		if (!isDeploymentJob(target.job.deployment)) {
			throw new Error("Persisted Git delivery job is invalid");
		}
		const job = {
			...target.job.deployment,
			gitDeliveryTargetId,
		} as DeploymentJob;
		if (IS_CLOUD && job.serverId) {
			await deploy(job);
			await markGitDeliveryTargetEnqueued(
				gitDeliveryTargetId,
				`cloud:${gitDeliveryTargetId}`,
			);
			return true;
		}
		const queued = await myQueue.add("deployments", job, {
			removeOnComplete: true,
			removeOnFail: true,
			jobId: gitDeliveryTargetId,
		});
		await markGitDeliveryTargetEnqueued(gitDeliveryTargetId, queued.id);
		await synchronizeGitDeliveryTargetReport(gitDeliveryTargetId).catch(
			(error) => console.error("Failed to report queued Git delivery", error),
		);
		return true;
	} catch (error) {
		await markGitDeliveryTargetEnqueueFailed(gitDeliveryTargetId, error);
		throw error;
	}
};

export const reconcileGitDelivery = async () => {
	const stateReconciled = await reconcileGitDeliveryTargetStates();
	const due = await listGitDeliveryTargetsDueForEnqueue();
	let enqueued = 0;
	let failed = 0;
	for (const target of due) {
		try {
			if (await enqueueGitDeliveryTarget(target.gitDeliveryTargetId))
				enqueued += 1;
		} catch (error) {
			failed += 1;
			console.error(
				`Failed to enqueue Git delivery target ${target.gitDeliveryTargetId}`,
				error,
			);
		}
	}
	const reports = await listGitDeliveryTargetsDueForReport();
	let reported = 0;
	for (const target of reports) {
		try {
			await synchronizeGitDeliveryTargetReport(target.gitDeliveryTargetId);
			reported += 1;
		} catch (error) {
			failed += 1;
			console.error(
				`Failed to synchronize Git delivery status ${target.gitDeliveryTargetId}`,
				error,
			);
		}
	}
	return { stateReconciled, enqueued, reported, failed };
};
