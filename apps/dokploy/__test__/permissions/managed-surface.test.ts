import { describe, expect, it } from "vitest";
import { managedTenantRouter } from "@/server/api/managed-root";
import { operatorRouter } from "@/server/api/operator-root";
import { canUsePlatformOperatorSurface } from "@/server/api/surface-policy";
import openApiDocument from "../../../../openapi.json";
import {
	isManagedTenantRoute,
	managedTenantPageSourceFragments,
	managedTenantRoutes,
	selfHostedOnlyPageSourceFragments,
} from "../../managed-surface.config.js";

const forbiddenNamespaces = [
	"admin",
	"backup",
	"certificates",
	"cluster",
	"compose",
	"destination",
	"docker",
	"libsql",
	"mariadb",
	"mongo",
	"mysql",
	"network",
	"platformEdge",
	"platformInfrastructure",
	"postgres",
	"redis",
	"registry",
	"schedule",
	"server",
	"sshKey",
	"swarm",
	"volumeBackups",
];

const allowedNamespaces = [
	"application",
	"deployment",
	"domain",
	"environment",
	"gitProvider",
	"managedData",
	"observability",
	"organization",
	"previewDeployment",
	"project",
	"settings",
	"stripe",
	"usage",
	"user",
];

describe("managed tenant API surface", () => {
	const procedures = Object.keys(
		(managedTenantRouter as unknown as { _def: { procedures: object } })._def
			.procedures,
	);

	it.each(forbiddenNamespaces)(
		"does not compile the %s router",
		(namespace) => {
			expect(
				procedures.some((procedure) => procedure.startsWith(`${namespace}.`)),
			).toBe(false);
		},
	);

	it.each(allowedNamespaces)("retains the %s product router", (namespace) => {
		expect(
			procedures.some((procedure) => procedure.startsWith(`${namespace}.`)),
		).toBe(true);
	});

	it.each([
		"managedData.platformProviders",
		"managedData.createPlatformProvider",
		"managedData.updatePlatformProvider",
		"managedData.activatePlatformProvider",
	])("omits operator procedure %s", (procedure) => {
		expect(procedures).not.toContain(procedure);
	});
});

describe("managed operator API separation", () => {
	const operatorProcedures = Object.keys(
		(operatorRouter as unknown as { _def: { procedures: object } })._def
			.procedures,
	);

	it("rejects platform operations on the tenant surface", () => {
		expect(
			canUsePlatformOperatorSurface({ managed: true, surface: "tenant" }),
		).toBe(false);
		expect(
			canUsePlatformOperatorSurface({ managed: true, surface: undefined }),
		).toBe(false);
	});

	it("accepts platform operations only on the operator surface", () => {
		expect(
			canUsePlatformOperatorSurface({ managed: true, surface: "operator" }),
		).toBe(true);
		expect(
			canUsePlatformOperatorSurface({ managed: false, surface: "tenant" }),
		).toBe(true);
	});

	it.each([
		"platformInfrastructure.all",
		"platformEdge.all",
		"managedData.platformProviders",
		"server.all",
	])("keeps %s on the operator router", (procedure) => {
		expect(operatorProcedures).toContain(procedure);
	});
});

describe("managed tenant page surface", () => {
	it.each(managedTenantRoutes)("blocks %s", (route) => {
		expect(isManagedTenantRoute(route)).toBe(true);
		expect(isManagedTenantRoute(`${route}/`)).toBe(true);
	});

	it.each([
		"compose",
		"libsql",
		"mariadb",
		"mongo",
		"mysql",
		"postgres",
		"redis",
	])("blocks legacy %s service pages", (service) => {
		expect(
			isManagedTenantRoute(
				`/dashboard/project/project-1/environment/environment-1/services/${service}/service-1`,
			),
		).toBe(true);
	});

	it("blocks the legacy compose deployment webhook", () => {
		expect(isManagedTenantRoute("/api/deploy/compose/secret-token")).toBe(true);
	});

	it.each([
		"/dashboard/home",
		"/dashboard/projects",
		"/dashboard/settings/billing",
		"/dashboard/settings/git-providers",
		"/dashboard/project/project-1/environment/environment-1/services/application/app-1",
	])("retains tenant product route %s", (route) => {
		expect(isManagedTenantRoute(route)).toBe(false);
	});

	it("has a build-time replacement source for every blocked page family", () => {
		expect(managedTenantPageSourceFragments.length).toBeGreaterThanOrEqual(
			managedTenantRoutes.length,
		);
		expect(
			managedTenantPageSourceFragments.some((source) =>
				source.includes("services/compose/[composeId].tsx"),
			),
		).toBe(true);
	});

	it("compiles the operator endpoint only into the managed target", () => {
		expect(selfHostedOnlyPageSourceFragments).toContain(
			"pages/api/operator/trpc/[trpc].ts",
		);
	});
});

describe("managed tenant OpenAPI surface", () => {
	const paths = Object.keys(openApiDocument.paths);
	it.each(forbiddenNamespaces)("omits %s operations", (namespace) => {
		expect(paths.some((path) => path.startsWith(`/${namespace}.`))).toBe(false);
	});

	it("retains application operations", () => {
		expect(paths.some((path) => path.startsWith("/application."))).toBe(true);
	});
});
