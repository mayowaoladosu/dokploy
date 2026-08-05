import {
	databaseByteSeconds,
	usageWindowStart,
} from "@dokploy/server/services/usage-metering";
import { describe, expect, it } from "vitest";

describe("usage metering windows", () => {
	const observedAt = new Date("2026-08-05T12:34:56.789Z");

	it("aligns hourly quotas to UTC hour boundaries", () => {
		expect(usageWindowStart("hour", observedAt).toISOString()).toBe(
			"2026-08-05T12:00:00.000Z",
		);
	});

	it("aligns daily quotas to UTC day boundaries", () => {
		expect(usageWindowStart("day", observedAt).toISOString()).toBe(
			"2026-08-05T00:00:00.000Z",
		);
	});

	it("aligns monthly quotas to UTC month boundaries", () => {
		expect(usageWindowStart("month", observedAt).toISOString()).toBe(
			"2026-08-01T00:00:00.000Z",
		);
	});

	it("converts database samples to exact integer byte-seconds", () => {
		expect(databaseByteSeconds(1_024n, 60_000)).toBe(61_440n);
		expect(databaseByteSeconds("5", 1_001)).toBe(10n);
		expect(() => databaseByteSeconds(5, 0)).toThrow("duration is invalid");
	});
});
