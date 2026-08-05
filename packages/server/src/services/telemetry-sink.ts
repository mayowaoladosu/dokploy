import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { emitOpenTelemetryLog } from "../telemetry/open-telemetry";
import {
	createDeploymentTelemetry,
	type DeploymentTelemetry,
} from "./deployment-telemetry";
import type { EdgePublication } from "./edge-router";
import {
	observabilityResourceId,
	observabilityTenantId,
} from "./observability";
import type { RuntimeHealthResult } from "./runtime-scheduler";

export type ReleaseTelemetryContext = {
	organizationId?: string;
	projectId?: string;
	environmentId?: string;
	applicationId?: string;
	releaseId?: string;
	deploymentId: string;
};

export type ReleaseTelemetryEvent = ReleaseTelemetryContext &
	(
		| {
				type: "release.initialized";
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
				imageRef: string;
		  }
	);

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

const otelMeter = metrics.getMeter("vlyv-release-orchestrator");
const releaseEvents = otelMeter.createCounter("vlyv_release_events", {
	description: "Durable release lifecycle events",
});
const buildDuration = otelMeter.createHistogram("vlyv_build_duration_ms", {
	description: "Managed build duration",
	unit: "ms",
});
const imageSize = otelMeter.createHistogram("vlyv_build_image_size_bytes", {
	description: "Managed build image size",
	unit: "By",
});
const runtimeReadiness = otelMeter.createHistogram(
	"vlyv_runtime_readiness_duration_ms",
	{ description: "Runtime rollout readiness duration", unit: "ms" },
);
const healthLatency = otelMeter.createHistogram(
	"vlyv_health_check_latency_ms",
	{
		description: "Release health-check latency",
		unit: "ms",
	},
);
const otelTracer = trace.getTracer("vlyv-release-orchestrator");

const telemetryAttributes = (event: ReleaseTelemetryEvent) => ({
	"vlyv.event.type": event.type,
	...(event.releaseId
		? {
				"vlyv.release.id": observabilityResourceId("release", event.releaseId),
			}
		: {}),
	...(event.applicationId
		? {
				"vlyv.application.id": observabilityResourceId(
					"application",
					event.applicationId,
				),
			}
		: {}),
	...(event.projectId
		? {
				"vlyv.project.id": observabilityResourceId("project", event.projectId),
			}
		: {}),
	...(event.environmentId
		? {
				"vlyv.environment.id": observabilityResourceId(
					"environment",
					event.environmentId,
				),
			}
		: {}),
	"vlyv.deployment.id": observabilityResourceId(
		"deployment",
		event.deploymentId,
	),
	...(event.organizationId
		? {
				"vlyv.organization.id": observabilityTenantId(event.organizationId),
			}
		: {}),
});

const telemetryMetricAttributes = (event: ReleaseTelemetryEvent) => ({
	"vlyv.event.type": event.type,
	...(event.organizationId
		? {
				"vlyv.organization.id": observabilityTenantId(event.organizationId),
			}
		: {}),
});

/** Emits low-cardinality lifecycle metrics and tenant-scoped OTLP logs/traces. */
export const createOpenTelemetrySink = (): TelemetrySink => ({
	record: async (event) => {
		const attributes = telemetryAttributes(event);
		const metricAttributes = telemetryMetricAttributes(event);
		releaseEvents.add(1, metricAttributes);
		switch (event.type) {
			case "build.completed":
				buildDuration.record(event.durationMs, metricAttributes);
				if (event.imageSizeBytes !== null) {
					imageSize.record(event.imageSizeBytes, metricAttributes);
				}
				break;
			case "runtime.ready":
				runtimeReadiness.record(event.readinessDurationMs, metricAttributes);
				break;
			case "health.completed":
				healthLatency.record(event.result.latencyMs, {
					...metricAttributes,
					"vlyv.health.passed": event.result.passed,
				});
				break;
			case "release.initialized":
			case "edge.published":
			case "rollback.completed":
				break;
		}
		otelTracer.startActiveSpan(
			`release.${event.type}`,
			{ attributes },
			(span) => {
				if (event.type === "health.completed" && !event.result.passed) {
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: event.result.error || "Release health verification failed",
					});
				} else {
					span.setStatus({ code: SpanStatusCode.OK });
				}
				span.end();
			},
		);
		emitOpenTelemetryLog(`release.${event.type}`, attributes);
	},
	flush: async () => undefined,
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
