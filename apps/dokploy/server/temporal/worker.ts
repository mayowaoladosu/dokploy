import path from "node:path";
import {
	OpenTelemetryActivityInboundInterceptor,
	OpenTelemetryActivityOutboundInterceptor,
} from "@temporalio/interceptors-opentelemetry";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { assertTemporalConfiguration } from "./config";

let worker: Worker | null = null;
let runPromise: Promise<void> | null = null;

export const startTemporalWorker = async () => {
	const config = assertTemporalConfiguration();
	if (!config.enabled || worker) return;
	const connection = await NativeConnection.connect({
		address: config.address,
		tls: config.tls,
		apiKey: config.apiKey,
	});
	worker = await Worker.create({
		connection,
		namespace: config.namespace,
		taskQueue: config.taskQueue,
		...(process.env.NODE_ENV === "production"
			? {
					workflowBundle: {
						codePath: path.join(import.meta.dirname, "temporal-workflows.js"),
					},
				}
			: { workflowsPath: path.join(import.meta.dirname, "workflows.ts") }),
		activities,
		interceptors: {
			activity: [
				(context) => ({
					inbound: new OpenTelemetryActivityInboundInterceptor(context),
					outbound: new OpenTelemetryActivityOutboundInterceptor(context),
				}),
			],
			...(process.env.NODE_ENV === "production"
				? {}
				: {
						workflowModules: [
							path.join(import.meta.dirname, "otel-workflow-interceptors.ts"),
						],
					}),
		},
		shutdownGraceTime: "30 seconds",
		shutdownForceTime: "2 minutes",
		maxConcurrentActivityTaskExecutions: config.maxConcurrentActivities,
	});
	runPromise = worker.run();
	runPromise.catch((error) => {
		console.error("Temporal worker stopped unexpectedly", error);
		process.exitCode = 1;
		process.kill(process.pid, "SIGTERM");
	});
};

export const stopTemporalWorker = async () => {
	if (!worker) return;
	worker.shutdown();
	await runPromise;
	worker = null;
	runPromise = null;
};
