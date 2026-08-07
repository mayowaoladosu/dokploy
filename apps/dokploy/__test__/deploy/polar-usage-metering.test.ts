import {
	createPolarEventClient,
	polarMeterEventIdentifier,
	polarUsageCutover,
	polarUsageDiscoveryStart,
} from "@dokploy/server/services/polar-usage-metering";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Polar usage event export", () => {
	beforeEach(() => {
		vi.stubEnv("POLAR_USAGE_CUTOVER_AT", "2026-01-01T00:00:00.000Z");
	});
	afterEach(() => vi.unstubAllEnvs());

	it("requires a canonical UTC cutover and never discovers older usage", () => {
		vi.stubEnv("POLAR_USAGE_MAX_EVENT_AGE_HOURS", "24");
		vi.stubEnv("POLAR_USAGE_CUTOVER_AT", "2026-08-09T12:00:00.000Z");
		expect(
			polarUsageDiscoveryStart(new Date("2026-08-10T00:00:00.000Z")),
		).toEqual(new Date("2026-08-09T12:00:00.000Z"));

		vi.stubEnv("POLAR_USAGE_CUTOVER_AT", "2026-08-01T00:00:00.000Z");
		expect(
			polarUsageDiscoveryStart(new Date("2026-08-10T00:00:00.000Z")),
		).toEqual(new Date("2026-08-09T00:00:00.000Z"));

		vi.stubEnv("POLAR_USAGE_CUTOVER_AT", "2026-08-09");
		expect(() => polarUsageCutover()).toThrow("canonical ISO-8601 UTC");
		vi.stubEnv("POLAR_USAGE_CUTOVER_AT", "");
		expect(() => polarUsageCutover()).toThrow("required before exporting");
	});

	it("creates deterministic replay-safe identifiers", () => {
		const identifier = polarMeterEventIdentifier("meter-1", "event-1");
		expect(identifier).toMatch(/^vlyv_[a-f0-9]{64}$/);
		expect(identifier).toBe(polarMeterEventIdentifier("meter-1", "event-1"));
		expect(identifier).not.toBe(
			polarMeterEventIdentifier("meter-1", "event-2"),
		);
	});

	it("ingests an idempotent metered event through the official SDK", async () => {
		const ingest = vi.fn(async () => ({ inserted: 1, duplicates: 0 }));
		const client = createPolarEventClient({
			accessToken: "polar_oat_abcdefghijklmnop",
			environment: "sandbox",
			client: { events: { ingest } },
		});

		await client.send({
			eventName: "vlyv.cpu_milliseconds",
			identifier: "vlyv_identifier",
			externalCustomerId: "organization-123",
			quantity: 42n,
			timestamp: new Date("2026-08-05T12:00:00.000Z"),
		});

		expect(ingest).toHaveBeenCalledWith({
			events: [
				{
					name: "vlyv.cpu_milliseconds",
					external_id: "vlyv_identifier",
					external_customer_id: "organization-123",
					timestamp: "2026-08-05T12:00:00.000Z",
					metadata: { quantity: 42 },
				},
			],
		});
	});

	it("rejects invalid credentials and unsafe quantities", async () => {
		expect(() =>
			createPolarEventClient({ accessToken: "not-a-polar-token" }),
		).toThrow("organization access token");

		const client = createPolarEventClient({
			accessToken: "polar_oat_abcdefghijklmnop",
			client: {
				events: { ingest: vi.fn(async () => ({ inserted: 1, duplicates: 0 })) },
			},
		});
		await expect(
			client.send({
				eventName: "vlyv.egress_bytes",
				identifier: "vlyv_identifier",
				externalCustomerId: "organization-123",
				quantity: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
				timestamp: new Date(),
			}),
		).rejects.toThrow("safe integer range");
	});
});
