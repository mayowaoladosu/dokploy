import { getManagedNetworkName } from "@dokploy/server/services/network";
import {
	assertManagedResourceLimits,
	assertNoManagedServerSelection,
	getManagedApplicationDomain,
	getManagedResourceDefaults,
	isPlatformAdminIdentity,
	type ManagedComputeCandidate,
	selectManagedComputeCandidate,
} from "@dokploy/server/services/platform";
import { describe, expect, it } from "vitest";

const candidate = (
	overrides: Partial<ManagedComputeCandidate>,
): ManagedComputeCandidate => ({
	serverId: "node-a",
	serverType: "deploy",
	workloadCount: 0,
	buildsConcurrency: 1,
	...overrides,
});

describe("managed platform policy", () => {
	it("does not confuse organization ownership with platform administration", () => {
		expect(isPlatformAdminIdentity({ id: "tenant-owner", role: "owner" })).toBe(
			false,
		);
		expect(
			isPlatformAdminIdentity({ id: "platform-admin", role: "admin" }),
		).toBe(true);
	});

	it("supports explicitly configured platform administrators", () => {
		expect(
			isPlatformAdminIdentity(
				{ id: "configured-admin", role: "user" },
				new Set(["configured-admin"]),
			),
		).toBe(true);
	});

	it("supports an explicitly configured platform administrator email", () => {
		expect(
			isPlatformAdminIdentity(
				{ id: "email-admin", email: "ADMIN@VLYV.DEV", role: "user" },
				new Set(),
				new Set(["admin@vlyv.dev"]),
			),
		).toBe(true);
	});

	it("does not create managed domains outside managed mode", () => {
		expect(getManagedApplicationDomain("example-app")).toBeNull();
	});

	it("normalizes the configured managed apps domain", () => {
		expect(
			getManagedApplicationDomain("example-app", "*.APPS.VLYV.DEV.", true),
		).toBe("example-app.apps.vlyv.dev");
	});

	it("leaves resource policy disabled outside managed mode", () => {
		expect(getManagedResourceDefaults()).toEqual({});
		expect(() =>
			assertManagedResourceLimits({ memoryLimit: "999999999999" }),
		).not.toThrow();
	});

	it("applies safe resource defaults and ceilings in managed mode", () => {
		expect(getManagedResourceDefaults(true)).toEqual({
			memoryLimit: String(512 * 1024 * 1024),
			memoryReservation: String(128 * 1024 * 1024),
			cpuLimit: "1000000000",
			cpuReservation: "250000000",
		});
		expect(() =>
			assertManagedResourceLimits(
				{ memoryLimit: String(2 * 1024 * 1024 * 1024 + 1) },
				true,
			),
		).toThrow(/managed plan limit/);
	});

	it("rejects tenant-selected compute in managed mode", () => {
		expect(() => assertNoManagedServerSelection("server-id", true)).toThrow(
			/managed by the platform/,
		);
		expect(() => assertNoManagedServerSelection(undefined, true)).not.toThrow();
	});

	it("creates stable, isolated network names without exposing organization IDs", () => {
		const first = getManagedNetworkName("organization-one");
		const second = getManagedNetworkName("organization-two");

		expect(first).toBe(getManagedNetworkName("organization-one"));
		expect(first).not.toBe(second);
		expect(first).toMatch(/^vlyv-[a-f0-9]{20}$/);
		expect(first).not.toContain("organization-one");
	});

	it("chooses the least-loaded deployment node deterministically", () => {
		const selected = selectManagedComputeCandidate(
			[
				candidate({ serverId: "node-b", workloadCount: 3 }),
				candidate({ serverId: "node-c", workloadCount: 1 }),
				candidate({ serverId: "node-a", workloadCount: 1 }),
			],
			"deploy",
		);

		expect(selected?.serverId).toBe("node-a");
	});

	it("accounts for build concurrency when choosing a build node", () => {
		const selected = selectManagedComputeCandidate(
			[
				candidate({
					serverId: "small-builder",
					serverType: "build",
					workloadCount: 2,
					buildsConcurrency: 1,
				}),
				candidate({
					serverId: "large-builder",
					serverType: "build",
					workloadCount: 4,
					buildsConcurrency: 4,
				}),
			],
			"build",
		);

		expect(selected?.serverId).toBe("large-builder");
	});
});
