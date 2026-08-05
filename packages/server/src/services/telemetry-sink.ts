import {
	createDeploymentTelemetry,
	type DeploymentTelemetry,
} from "./deployment-telemetry";
import type { EdgePublication } from "./edge-router";
import type { RuntimeHealthResult } from "./runtime-scheduler";

export type ReleaseTelemetryEvent =
	| {
			type: "release.initialized";
			deploymentId: string;
			applicationId: string;
	  }
	| {
			type: "build.completed";
			deploymentId: string;
			durationMs: number;
			imageSizeBytes: number | null;
	  }
	| {
			type: "runtime.ready";
			deploymentId: string;
			runtimeDurationMs: number;
			readinessDurationMs: number;
	  }
	| {
			type: "health.completed";
			deploymentId: string;
			result: RuntimeHealthResult;
	  }
	| {
			type: "edge.published";
			deploymentId: string;
			publication: EdgePublication;
	  }
	| {
			type: "rollback.completed";
			deploymentId: string;
			imageRef: string;
	  };

/** One event interface hides persistence and external telemetry fan-out. */
export interface TelemetrySink {
	record(event: ReleaseTelemetryEvent): Promise<void>;
	flush(): Promise<void>;
}

export const createDatabaseTelemetrySink = (
	telemetry: DeploymentTelemetry = createDeploymentTelemetry(),
): TelemetrySink => ({
	record: async (event) => {
		switch (event.type) {
			case "release.initialized":
				await telemetry.initialize(event.deploymentId, event.applicationId);
				break;
			case "build.completed":
				await telemetry.recordBuild(
					event.deploymentId,
					event.durationMs,
					event.imageSizeBytes,
				);
				break;
			case "runtime.ready":
				await telemetry.recordRuntime(
					event.deploymentId,
					event.runtimeDurationMs,
					event.readinessDurationMs,
				);
				break;
			case "health.completed":
				await telemetry.recordHealth(event.deploymentId, event.result);
				break;
			case "edge.published":
			case "rollback.completed":
				break;
		}
	},
	flush: async () => undefined,
});

export const createCompositeTelemetrySink = (
	sinks: readonly TelemetrySink[],
): TelemetrySink => ({
	record: async (event) => {
		const results = await Promise.allSettled(
			sinks.map((sink) => sink.record(event)),
		);
		const rejected = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejected) throw rejected.reason;
	},
	flush: async () => {
		const results = await Promise.allSettled(sinks.map((sink) => sink.flush()));
		const rejected = results.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejected) throw rejected.reason;
	},
});

export const recordReleaseTelemetryBestEffort = async (
	operation: () => Promise<void>,
) => {
	try {
		await operation();
	} catch (error) {
		console.error("Failed to persist release telemetry", error);
	}
};
