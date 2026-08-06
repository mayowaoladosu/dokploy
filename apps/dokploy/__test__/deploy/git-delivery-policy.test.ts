import { classifyGitBranchEnvironmentMapping } from "@dokploy/server/services/git-delivery";
import { previewDeploymentExpiry } from "@dokploy/server/services/preview-deployment";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
	delete process.env.PREVIEW_DEPLOYMENT_TTL_HOURS;
});

describe("Git branch environment mapping", () => {
	it("maps the explicitly configured source branch", () => {
		expect(
			classifyGitBranchEnvironmentMapping({
				configuredBranch: "develop",
				environmentName: "QA",
				isDefaultEnvironment: false,
				incomingBranch: "develop",
				autoDeploy: true,
			}),
		).toEqual({ matches: true, isProduction: false });
	});

	it("automatically maps a branch named for its environment", () => {
		expect(
			classifyGitBranchEnvironmentMapping({
				configuredBranch: "develop",
				environmentName: "Feature Staging",
				isDefaultEnvironment: false,
				incomingBranch: "feature-staging",
				autoDeploy: true,
			}),
		).toEqual({ matches: true, isProduction: false });
	});

	it.each(["main", "master", "production"])(
		"promotes %s to the default production environment",
		(incomingBranch) => {
			expect(
				classifyGitBranchEnvironmentMapping({
					configuredBranch: "legacy-production",
					environmentName: "Production",
					isDefaultEnvironment: true,
					incomingBranch,
					autoDeploy: true,
				}),
			).toEqual({ matches: true, isProduction: true });
		},
	);

	it("does not map unrelated branches or disabled auto-deploy targets", () => {
		expect(
			classifyGitBranchEnvironmentMapping({
				configuredBranch: "develop",
				environmentName: "Staging",
				isDefaultEnvironment: false,
				incomingBranch: "feature/untrusted",
				autoDeploy: true,
			}),
		).toEqual({ matches: false, isProduction: false });
		expect(
			classifyGitBranchEnvironmentMapping({
				configuredBranch: "main",
				environmentName: "Production",
				isDefaultEnvironment: true,
				incomingBranch: "main",
				autoDeploy: false,
			}),
		).toEqual({ matches: false, isProduction: true });
	});
});

describe("preview expiry policy", () => {
	it("defaults to seven days", () => {
		const now = new Date("2026-08-06T00:00:00.000Z");
		expect(previewDeploymentExpiry(now)).toEqual(
			new Date("2026-08-13T00:00:00.000Z"),
		);
	});

	it("supports a bounded operator TTL and rejects unsafe values", () => {
		const now = new Date("2026-08-06T00:00:00.000Z");
		process.env.PREVIEW_DEPLOYMENT_TTL_HOURS = "24";
		expect(previewDeploymentExpiry(now)).toEqual(
			new Date("2026-08-07T00:00:00.000Z"),
		);
		process.env.PREVIEW_DEPLOYMENT_TTL_HOURS = "10000";
		expect(previewDeploymentExpiry(now)).toEqual(
			new Date("2026-08-13T00:00:00.000Z"),
		);
	});
});
