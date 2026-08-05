import { managedDataUsagePeriod } from "@dokploy/server/services/managed-data-usage-metering";
import { describe, expect, it } from "vitest";

describe("managed database usage periods", () => {
	const observedAt = new Date("2026-08-05T12:00:00.000Z");

	it("meters a bounded first sample", () => {
		expect(managedDataUsagePeriod(null, observedAt)).toEqual({
			periodStart: new Date("2026-08-05T11:00:00.000Z"),
			periodEnd: observedAt,
		});
	});

	it("uses the prior checkpoint while capping outage backfill", () => {
		expect(
			managedDataUsagePeriod(new Date("2026-08-05T11:45:00.000Z"), observedAt),
		).toEqual({
			periodStart: new Date("2026-08-05T11:45:00.000Z"),
			periodEnd: observedAt,
		});
		expect(
			managedDataUsagePeriod(new Date("2026-08-04T00:00:00.000Z"), observedAt),
		).toEqual({
			periodStart: new Date("2026-08-05T11:00:00.000Z"),
			periodEnd: observedAt,
		});
	});

	it("ignores repeated or backward samples", () => {
		expect(managedDataUsagePeriod(observedAt, observedAt)).toBeNull();
		expect(
			managedDataUsagePeriod(new Date("2026-08-05T12:01:00.000Z"), observedAt),
		).toBeNull();
	});
});
