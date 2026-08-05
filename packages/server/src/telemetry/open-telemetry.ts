import type { IncomingMessage, ServerResponse } from "node:http";
import { metrics, SpanStatusCode, trace } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const DEFAULT_PROMETHEUS_PORT = 9464;
const DEFAULT_EXPORT_INTERVAL_MS = 30_000;
const HEADER_NAME = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,128}$/;

let sdk: NodeSDK | null = null;
let started = false;

const booleanEnvironment = (name: string, fallback: boolean) => {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`${name} must be true or false`);
};

const integerEnvironment = (
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
) => {
	const value = process.env[name]?.trim();
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
	}
	return parsed;
};

const cleanOtlpEndpoint = (value: string) => {
	const url = new URL(value);
	if (
		!(["https:", "http:"] as const).includes(
			url.protocol as "https:" | "http:",
		) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("OTLP endpoint is invalid");
	}
	return url.toString().replace(/\/$/, "");
};

const parseOtlpHeaders = (value: string | undefined) => {
	if (!value?.trim()) return undefined;
	const headers: Record<string, string> = {};
	for (const entry of value.split(",")) {
		const separator = entry.indexOf("=");
		if (separator <= 0) throw new Error("OTLP headers are invalid");
		const name = decodeURIComponent(entry.slice(0, separator).trim());
		const headerValue = decodeURIComponent(entry.slice(separator + 1).trim());
		if (!HEADER_NAME.test(name) || /[\r\n]/.test(headerValue)) {
			throw new Error("OTLP headers are invalid");
		}
		headers[name] = headerValue;
	}
	return headers;
};

const signalEndpoint = (
	signal: "traces" | "metrics" | "logs",
	baseEndpoint: string,
) => {
	const override =
		process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`];
	if (override?.trim()) return cleanOtlpEndpoint(override.trim());
	return `${baseEndpoint}/v1/${signal}`;
};

export type OpenTelemetryConfiguration = {
	enabled: boolean;
	serviceName: string;
	serviceVersion?: string;
	prometheusEnabled: boolean;
	prometheusHost: string;
	prometheusPort: number;
	prometheusEndpoint: string;
	otlpEndpoint?: string;
	exportIntervalMs: number;
};

export const openTelemetryConfiguration = (): OpenTelemetryConfiguration => {
	const enabled = booleanEnvironment(
		"OTEL_ENABLED",
		process.env.NODE_ENV === "production",
	);
	const otlpValue = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
	const prometheusEnabled = booleanEnvironment(
		"OTEL_PROMETHEUS_ENABLED",
		!otlpValue,
	);
	const prometheusEndpoint =
		process.env.OTEL_PROMETHEUS_ENDPOINT?.trim() || "/metrics";
	if (
		!prometheusEndpoint.startsWith("/") ||
		prometheusEndpoint.includes("\0")
	) {
		throw new Error("OTEL_PROMETHEUS_ENDPOINT must be an absolute path");
	}
	const prometheusHost =
		process.env.OTEL_PROMETHEUS_HOST?.trim() || "127.0.0.1";
	if (
		!/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[a-fA-F0-9:]+\])$/.test(
			prometheusHost,
		)
	) {
		throw new Error("OTEL_PROMETHEUS_HOST must be an IP address or localhost");
	}
	return {
		enabled,
		serviceName: process.env.OTEL_SERVICE_NAME?.trim() || "vlyv-control-plane",
		serviceVersion: process.env.OTEL_SERVICE_VERSION?.trim() || undefined,
		prometheusEnabled,
		prometheusHost,
		prometheusPort: integerEnvironment(
			"OTEL_PROMETHEUS_PORT",
			DEFAULT_PROMETHEUS_PORT,
			1,
			65_535,
		),
		prometheusEndpoint,
		otlpEndpoint: otlpValue ? cleanOtlpEndpoint(otlpValue) : undefined,
		exportIntervalMs: integerEnvironment(
			"OTEL_METRIC_EXPORT_INTERVAL_MS",
			DEFAULT_EXPORT_INTERVAL_MS,
			1_000,
			300_000,
		),
	};
};

export const initializeOpenTelemetry = () => {
	if (started)
		return { enabled: true, configuration: openTelemetryConfiguration() };
	const configuration = openTelemetryConfiguration();
	if (!configuration.enabled) return { enabled: false, configuration };
	const metricReaders = [];
	if (configuration.prometheusEnabled) {
		metricReaders.push(
			new PrometheusExporter({
				host: configuration.prometheusHost,
				port: configuration.prometheusPort,
				endpoint: configuration.prometheusEndpoint,
				preventServerStart: false,
			}),
		);
	}
	const headers = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
	const logRecordProcessors = [];
	let traceExporter: OTLPTraceExporter | undefined;
	if (configuration.otlpEndpoint) {
		metricReaders.push(
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({
					url: signalEndpoint("metrics", configuration.otlpEndpoint),
					headers,
				}),
				exportIntervalMillis: configuration.exportIntervalMs,
			}),
		);
		traceExporter = new OTLPTraceExporter({
			url: signalEndpoint("traces", configuration.otlpEndpoint),
			headers,
		});
		logRecordProcessors.push(
			new BatchLogRecordProcessor({
				exporter: new OTLPLogExporter({
					url: signalEndpoint("logs", configuration.otlpEndpoint),
					headers,
				}),
			}),
		);
	}
	if (
		metricReaders.length === 0 &&
		!traceExporter &&
		logRecordProcessors.length === 0
	) {
		throw new Error("OpenTelemetry is enabled without an exporter");
	}
	const attributes: Record<string, string> = {
		[ATTR_SERVICE_NAME]: configuration.serviceName,
		"deployment.environment.name": process.env.NODE_ENV || "development",
	};
	if (configuration.serviceVersion) {
		attributes[ATTR_SERVICE_VERSION] = configuration.serviceVersion;
	}
	sdk = new NodeSDK({
		resource: resourceFromAttributes(attributes),
		metricReaders,
		...(traceExporter ? { traceExporter } : {}),
		...(logRecordProcessors.length > 0 ? { logRecordProcessors } : {}),
	});
	sdk.start();
	started = true;
	return { enabled: true, configuration };
};

export const shutdownOpenTelemetry = async () => {
	const active = sdk;
	sdk = null;
	started = false;
	if (active) await active.shutdown();
};

const meter = metrics.getMeter("vlyv-control-plane");
const httpRequestCounter = meter.createCounter("vlyv_http_server_requests", {
	description: "HTTP requests handled by the vlyv control plane",
});
const httpDuration = meter.createHistogram("vlyv_http_server_duration_ms", {
	description: "HTTP control-plane request duration",
	unit: "ms",
});
const tracer = trace.getTracer("vlyv-control-plane-http");
const logger = logs.getLogger("vlyv-control-plane");

const routeName = (request: IncomingMessage) => {
	try {
		const pathname = new URL(request.url || "/", "http://vlyv.invalid")
			.pathname;
		return pathname
			.split("/")
			.map((segment) =>
				segment.length >= 12 && /^[a-zA-Z0-9_-]+$/.test(segment)
					? ":id"
					: segment,
			)
			.join("/")
			.slice(0, 300);
	} catch {
		return "/invalid";
	}
};

export const handleHttpRequestWithTelemetry = async (
	request: IncomingMessage,
	response: ServerResponse,
	handler: () => Promise<void>,
) => {
	const method = request.method || "UNKNOWN";
	const route = routeName(request);
	return tracer.startActiveSpan(
		`${method} ${route}`,
		{
			attributes: {
				"http.request.method": method,
				"http.route": route,
			},
		},
		async (span) => {
			const startedAt = performance.now();
			let completed = false;
			const complete = (error?: unknown) => {
				if (completed) return;
				completed = true;
				const durationMs = performance.now() - startedAt;
				const attributes = {
					"http.request.method": method,
					"http.route": route,
					"http.response.status_code": response.statusCode,
				};
				httpRequestCounter.add(1, attributes);
				httpDuration.record(durationMs, attributes);
				span.setAttributes(attributes);
				if (error) {
					span.recordException(
						error instanceof Error ? error : new Error(String(error)),
					);
					span.setStatus({ code: SpanStatusCode.ERROR });
				} else {
					span.setStatus({
						code:
							response.statusCode >= 500
								? SpanStatusCode.ERROR
								: SpanStatusCode.OK,
					});
				}
				span.end();
			};
			response.once("finish", () => complete());
			response.once("close", () => complete());
			try {
				await handler();
				if (response.writableFinished) complete();
			} catch (error) {
				complete(error);
				throw error;
			}
		},
	);
};

export const emitOpenTelemetryLog = (
	body: string,
	attributes: Record<string, string | number | boolean>,
	severityNumber: SeverityNumber = SeverityNumber.INFO,
) => {
	logger.emit({
		body,
		severityNumber,
		severityText: SeverityNumber[severityNumber],
		attributes,
	});
};
