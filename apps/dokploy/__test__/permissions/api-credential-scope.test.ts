import type { ApiCredentialScope } from "@dokploy/server/db/schema";
import {
	apiCredentialScopeInput,
	assertApiCredentialScope,
} from "@dokploy/server/services/api-credential-scope";
import { describe, expect, it } from "vitest";

const scope = {
	permissions: ["api:read", "deployment:create", "domain:read"],
	projectIds: ["project-1"],
	environmentIds: ["environment-1"],
	serviceIds: ["application-1"],
} as ApiCredentialScope;

describe("API credential scopes", () => {
	it("rejects global wildcard permissions", () => {
		expect(() =>
			apiCredentialScopeInput.parse({
				permissions: ["*"],
				projectIds: [],
				environmentIds: [],
				serviceIds: [],
			}),
		).toThrow();
	});

	it("allows matching permissions and object IDs", () => {
		expect(() =>
			assertApiCredentialScope(scope, "deployment", "create", {
				projectId: "project-1",
				environmentId: "environment-1",
				applicationId: "application-1",
			}),
		).not.toThrow();
	});

	it("rejects actions outside the credential permission set", () => {
		expect(() =>
			assertApiCredentialScope(scope, "deployment", "cancel", {
				applicationId: "application-1",
			}),
		).toThrow("does not permit");
	});

	it("rejects resources outside the credential object scope", () => {
		expect(() =>
			assertApiCredentialScope(scope, "deployment", "create", {
				applicationId: "application-2",
			}),
		).toThrow("does not permit");
	});

	it("preserves legacy unscoped API keys", () => {
		expect(() =>
			assertApiCredentialScope(null, "deployment", "create", {
				applicationId: "application-2",
			}),
		).not.toThrow();
	});
});
