import { db } from "@dokploy/server/db";
import { deploymentMetrics } from "@dokploy/server/db/schema";
import { eq, sql } from "drizzle-orm";
import type { RuntimeHealthResult } from "./runtime-scheduler";

export interface DeploymentTelemetry {
	initialize(deploymentId: string, applicationId: string): Promise<void>;
	recordBuild(
		deploymentId: string,
		durationMs: number,
		imageSizeBytes: number | null,
	): Promise<void>;
	recordRuntime(
		deploymentId: string,
		runtimeDurationMs: number,
		readinessDurationMs: number,
	): Promise<void>;
	recordHealth(
		deploymentId: string,
		result: RuntimeHealthResult,
	): Promise<void>;
}

export const createDeploymentTelemetry = (): DeploymentTelemetry => ({
	initialize: async (deploymentId, applicationId) => {
		await db
			.insert(deploymentMetrics)
			.values({ deploymentId, applicationId })
			.onConflictDoNothing({ target: deploymentMetrics.deploymentId });
	},
	recordBuild: async (deploymentId, durationMs, imageSizeBytes) => {
		await db
			.update(deploymentMetrics)
			.set({
				buildDurationMs: durationMs,
				imageSizeBytes,
				updatedAt: new Date(),
			})
			.where(eq(deploymentMetrics.deploymentId, deploymentId));
	},
	recordRuntime: async (
		deploymentId,
		runtimeDurationMs,
		readinessDurationMs,
	) => {
		await db
			.update(deploymentMetrics)
			.set({
				runtimeDurationMs,
				readinessDurationMs,
				updatedAt: new Date(),
			})
			.where(eq(deploymentMetrics.deploymentId, deploymentId));
	},
	recordHealth: async (deploymentId, result) => {
		await db
			.update(deploymentMetrics)
			.set({
				healthCheckCount: sql`${deploymentMetrics.healthCheckCount} + 1`,
				healthCheckPassCount: result.passed
					? sql`${deploymentMetrics.healthCheckPassCount} + 1`
					: deploymentMetrics.healthCheckPassCount,
				healthCheckFailCount: result.passed
					? deploymentMetrics.healthCheckFailCount
					: sql`${deploymentMetrics.healthCheckFailCount} + 1`,
				healthCheckLatencyMs: result.latencyMs,
				healthCheckCheckedAt: new Date(result.checkedAt),
				updatedAt: new Date(),
			})
			.where(eq(deploymentMetrics.deploymentId, deploymentId));
	},
});

export const recordTelemetryBestEffort = async (
	operation: () => Promise<void>,
) => {
	try {
		await operation();
	} catch (error) {
		console.error("Failed to persist deployment telemetry", error);
	}
};
