import { db } from "@dokploy/server/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPolarWebhook } from "@/pages/api/polar/webhook";

const claimChain = (
	inserted: unknown[],
	reclaimed: unknown[],
): {
	insert: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
} => ({
	insert: vi.fn(() => ({
		values: () => ({
			onConflictDoNothing: () => ({ returning: async () => inserted }),
		}),
	})),
	update: vi.fn(() => ({
		set: () => ({
			where: () => ({ returning: async () => reclaimed }),
		}),
	})),
});

describe("Polar webhook durable claims", () => {
	afterEach(() => vi.restoreAllMocks());

	it("claims a previously unseen provider event", async () => {
		const chain = claimChain([{ id: "event-1" }], []);
		vi.spyOn(db, "insert").mockImplementation(chain.insert as never);
		vi.spyOn(db, "update").mockImplementation(chain.update as never);

		await expect(
			claimPolarWebhook(
				"event-1",
				"customer.state_changed",
				new Date("2026-08-06T12:00:00.000Z"),
			),
		).resolves.toBe("claimed");
		expect(chain.update).not.toHaveBeenCalled();
	});

	it("reclaims a failed or stale provider event for retry", async () => {
		const chain = claimChain([], [{ id: "event-1" }]);
		vi.spyOn(db, "insert").mockImplementation(chain.insert as never);
		vi.spyOn(db, "update").mockImplementation(chain.update as never);

		await expect(
			claimPolarWebhook(
				"event-1",
				"subscription.updated",
				new Date("2026-08-06T12:00:00.000Z"),
			),
		).resolves.toBe("claimed");
	});

	it("acknowledges an already processed duplicate without processing again", async () => {
		const chain = claimChain([], []);
		vi.spyOn(db, "insert").mockImplementation(chain.insert as never);
		vi.spyOn(db, "update").mockImplementation(chain.update as never);
		vi.mocked(db.query.polarWebhookEvents.findFirst).mockResolvedValue({
			status: "processed",
		} as never);

		await expect(
			claimPolarWebhook(
				"event-1",
				"order.paid",
				new Date("2026-08-06T12:00:00.000Z"),
			),
		).resolves.toBe("processed");
	});

	it("rejects concurrent processing claims", async () => {
		const chain = claimChain([], []);
		vi.spyOn(db, "insert").mockImplementation(chain.insert as never);
		vi.spyOn(db, "update").mockImplementation(chain.update as never);
		vi.mocked(db.query.polarWebhookEvents.findFirst).mockResolvedValue({
			status: "processing",
		} as never);

		await expect(
			claimPolarWebhook(
				"event-1",
				"order.paid",
				new Date("2026-08-06T12:00:00.000Z"),
			),
		).resolves.toBe("busy");
	});
});
