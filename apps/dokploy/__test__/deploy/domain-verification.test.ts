import { normalizeDomainHost } from "@dokploy/server/services/domain";
import { isPlatformManagedHostname } from "@dokploy/server/services/domain-verification";
import { afterEach, describe, expect, it } from "vitest";

const originalDomain = process.env.PLATFORM_APPS_DOMAIN;

afterEach(() => {
	process.env.PLATFORM_APPS_DOMAIN = originalDomain;
});

describe("managed domain ownership", () => {
	it("normalizes case, whitespace, and a trailing DNS dot", () => {
		expect(normalizeDomainHost("  APP.Example.COM. ")).toBe("app.example.com");
	});

	it("trusts only hostnames beneath the platform-owned apps domain", () => {
		process.env.PLATFORM_APPS_DOMAIN = "*.apps.vlyv.dev.";

		expect(isPlatformManagedHostname("app-123.apps.vlyv.dev")).toBe(true);
		expect(isPlatformManagedHostname("apps.vlyv.dev")).toBe(true);
		expect(isPlatformManagedHostname("apps.vlyv.dev.attacker.example")).toBe(
			false,
		);
		expect(isPlatformManagedHostname("customer.example.com")).toBe(false);
	});
});
