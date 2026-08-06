import type { ApiCredentialScope } from "@dokploy/server/db/schema";
import {
	checkEnvironmentAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { memberRecord } = vi.hoisted(() => ({
	memberRecord: {
		id: "member-1",
		userId: "user-1",
		organizationId: "organization-1",
		role: "member",
		accessedProjects: ["project-allowed"],
		accessedEnvironments: ["environment-allowed"],
		accessedServices: ["application-allowed"],
		canCreateProjects: false,
		canDeleteProjects: false,
		canCreateServices: false,
		canDeleteServices: false,
		canCreateEnvironments: false,
		canDeleteEnvironments: false,
		canAccessToTraefikFiles: false,
		canAccessToDocker: false,
		canAccessToAPI: false,
		canAccessToSSHKeys: false,
		canAccessToGitProviders: false,
		user: {},
	},
}));

vi.mock("@dokploy/server/db", () => ({
	db: {
		query: {
			member: { findFirst: vi.fn(async () => memberRecord) },
			organizationRole: { findMany: vi.fn(async () => []) },
		},
	},
}));
vi.mock("@dokploy/server/services/proprietary/license-key", () => ({
	hasValidLicense: vi.fn(async () => false),
}));

const ctx = {
	user: { id: "user-1" },
	session: {
		activeOrganizationId: "organization-1",
		apiCredentialScope: null as ApiCredentialScope | null,
	},
};

describe("managed data authorization foundations", () => {
	beforeEach(() => {
		ctx.session.apiCredentialScope = null;
	});

	it("resolves member project and environment assignments", async () => {
		await expect(
			findMemberByUserId("user-1", "organization-1"),
		).resolves.toMatchObject({
			accessedProjects: ["project-allowed"],
			accessedEnvironments: ["environment-allowed"],
		});
	});

	it("rejects member access outside assigned environments", async () => {
		await expect(
			checkEnvironmentAccess(ctx, "environment-denied", "read"),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
		await expect(
			checkEnvironmentAccess(ctx, "environment-allowed", "read"),
		).resolves.toBeUndefined();
	});

	it("also enforces API credential environment scope", async () => {
		ctx.session.apiCredentialScope = {
			apiKeyId: "api-key-1",
			organizationId: "organization-1",
			permissions: ["environment:read"],
			projectIds: [],
			environmentIds: ["environment-other"],
			serviceIds: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await expect(
			checkEnvironmentAccess(ctx, "environment-allowed", "read"),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
