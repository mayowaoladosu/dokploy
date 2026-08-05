import {
	createStripeMeterEventClient,
	stripeMeterEventIdentifier,
} from "@dokploy/server/services/stripe-usage-metering";
import { describe, expect, it, vi } from "vitest";

describe("Stripe usage meter export", () => {
	it("creates deterministic replay-safe identifiers", () => {
		const identifier = stripeMeterEventIdentifier("meter-1", "event-1");
		expect(identifier).toMatch(/^vlyv_[a-f0-9]{64}$/);
		expect(identifier).toBe(stripeMeterEventIdentifier("meter-1", "event-1"));
		expect(identifier).not.toBe(
			stripeMeterEventIdentifier("meter-1", "event-2"),
		);
	});

	it("sends Stripe Billing Meter Events with idempotency", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ object: "billing.meter_event" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
		);
		const client = createStripeMeterEventClient({
			apiKey: "sk_test_usage_meter",
			apiBase: "https://stripe.test/v1",
			fetcher,
		});

		await client.send({
			eventName: "vlyv_cpu_ms",
			identifier: "vlyv_identifier",
			customerId: "cus_customer123",
			quantity: 42n,
			timestamp: new Date("2026-08-05T12:00:00.000Z"),
		});

		expect(fetcher).toHaveBeenCalledTimes(1);
		const [url, init] = fetcher.mock.calls[0] ?? [];
		expect(String(url)).toBe("https://stripe.test/v1/billing/meter_events");
		expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(
			"vlyv_identifier",
		);
		const body = new URLSearchParams(String(init?.body));
		expect(body.get("event_name")).toBe("vlyv_cpu_ms");
		expect(body.get("payload[stripe_customer_id]")).toBe("cus_customer123");
		expect(body.get("payload[value]")).toBe("42");
	});

	it("rejects public keys and insecure API endpoints", () => {
		expect(() =>
			createStripeMeterEventClient({ apiKey: "pk_test_public" }),
		).toThrow("secret API key");
		expect(() =>
			createStripeMeterEventClient({
				apiKey: "sk_test_secret",
				apiBase: "http://stripe.local/v1",
			}),
		).toThrow("clean HTTPS");
	});
});
