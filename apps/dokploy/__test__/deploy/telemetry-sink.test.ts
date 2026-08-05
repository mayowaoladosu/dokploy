import {
	createCompositeTelemetrySink,
	createDatabaseTelemetrySink,
	type TelemetrySink,
} from "@dokploy/server/services/telemetry-sink";
import { describe, expect, it, vi } from "vitest";

describe("telemetry sink", () => {
	it("maps release events to durable deployment telemetry", async () => {
		const telemetry = {
			initialize: vi.fn(async () => undefined),
			recordBuild: vi.fn(async () => undefined),
			recordRuntime: vi.fn(async () => undefined),
			recordHealth: vi.fn(async () => undefined),
		};
		const sink = createDatabaseTelemetrySink(telemetry);

		await sink.record({
			type: "build.completed",
			deploymentId: "deployment-1",
			durationMs: 250,
			imageSizeBytes: 1_024,
		});

		expect(telemetry.recordBuild).toHaveBeenCalledWith(
			"deployment-1",
			250,
			1_024,
		);
	});

	it("fans out events and flushes every adapter", async () => {
		const first: TelemetrySink = {
			record: vi.fn(async () => undefined),
			flush: vi.fn(async () => undefined),
		};
		const second: TelemetrySink = {
			record: vi.fn(async () => undefined),
			flush: vi.fn(async () => undefined),
		};
		const sink = createCompositeTelemetrySink([first, second]);
		const event = {
			type: "release.initialized" as const,
			deploymentId: "deployment-1",
			applicationId: "application-1",
		};

		await sink.record(event);
		await sink.flush();

		expect(first.record).toHaveBeenCalledWith(event);
		expect(second.record).toHaveBeenCalledWith(event);
		expect(first.flush).toHaveBeenCalledTimes(1);
		expect(second.flush).toHaveBeenCalledTimes(1);
	});
});
