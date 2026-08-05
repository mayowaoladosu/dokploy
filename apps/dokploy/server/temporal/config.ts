import { IS_MANAGED_PAAS } from "@dokploy/server";

export const temporalConfiguration = () => ({
	enabled:
		IS_MANAGED_PAAS && process.env.TEMPORAL_ENABLED?.toLowerCase() === "true",
	address: process.env.TEMPORAL_ADDRESS || "localhost:7233",
	namespace: process.env.TEMPORAL_NAMESPACE || "default",
	taskQueue: process.env.TEMPORAL_TASK_QUEUE || "vlyv-deployments",
	apiKey: process.env.TEMPORAL_API_KEY?.trim() || undefined,
	tls: process.env.TEMPORAL_TLS
		? process.env.TEMPORAL_TLS.toLowerCase() === "true"
		: Boolean(process.env.TEMPORAL_API_KEY?.trim()),
	maxConcurrentActivities: Number.parseInt(
		process.env.TEMPORAL_MAX_CONCURRENT_ACTIVITIES || "10",
		10,
	),
	cancellationWaitMs: Number.parseInt(
		process.env.TEMPORAL_CANCELLATION_WAIT_MS || "120000",
		10,
	),
});

export const assertTemporalConfiguration = () => {
	const config = temporalConfiguration();
	if (!config.enabled) return config;
	if (!config.address.trim()) throw new Error("TEMPORAL_ADDRESS is required");
	if (!config.namespace.trim())
		throw new Error("TEMPORAL_NAMESPACE is required");
	if (!config.taskQueue.trim())
		throw new Error("TEMPORAL_TASK_QUEUE is required");
	if (config.apiKey && !config.tls) {
		throw new Error("TEMPORAL_API_KEY requires TEMPORAL_TLS=true");
	}
	if (
		!Number.isInteger(config.maxConcurrentActivities) ||
		config.maxConcurrentActivities < 1 ||
		config.maxConcurrentActivities > 1_000
	) {
		throw new Error(
			"TEMPORAL_MAX_CONCURRENT_ACTIVITIES must be an integer from 1 to 1000",
		);
	}
	if (
		!Number.isInteger(config.cancellationWaitMs) ||
		config.cancellationWaitMs < 5_000 ||
		config.cancellationWaitMs > 600_000
	) {
		throw new Error(
			"TEMPORAL_CANCELLATION_WAIT_MS must be an integer from 5000 to 600000",
		);
	}
	return config;
};
