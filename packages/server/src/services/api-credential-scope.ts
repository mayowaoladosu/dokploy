import { db } from "@dokploy/server/db";
import {
	type ApiCredentialScope,
	apiCredentialScopes,
	applications,
	compose,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

export const apiCredentialScopeInput = z.object({
	permissions: z
		.array(z.string().regex(/^[a-zA-Z]+:[a-zA-Z*]+$/))
		.min(1)
		.max(100),
	projectIds: z.array(z.string().min(1)).max(100).default([]),
	environmentIds: z.array(z.string().min(1)).max(200).default([]),
	serviceIds: z.array(z.string().min(1)).max(500).default([]),
});

export type ApiCredentialScopeInput = z.infer<typeof apiCredentialScopeInput>;

const unauthorizedScope = () =>
	new TRPCError({
		code: "FORBIDDEN",
		message: "API credential scope does not permit this operation",
	});

export const validateApiCredentialScope = async (
	organizationId: string,
	scope: ApiCredentialScopeInput,
) => {
	if (scope.projectIds.length > 0) {
		const rows = await db.query.projects.findMany({
			where: inArray(projects.projectId, scope.projectIds),
			columns: { projectId: true, organizationId: true },
		});
		if (
			rows.length !== new Set(scope.projectIds).size ||
			rows.some((project) => project.organizationId !== organizationId)
		) {
			throw unauthorizedScope();
		}
	}
	if (scope.environmentIds.length > 0) {
		const rows = await db.query.environments.findMany({
			where: inArray(environments.environmentId, scope.environmentIds),
			columns: { environmentId: true },
			with: { project: { columns: { organizationId: true } } },
		});
		if (
			rows.length !== new Set(scope.environmentIds).size ||
			rows.some(
				(environment) => environment.project.organizationId !== organizationId,
			)
		) {
			throw unauthorizedScope();
		}
	}
	if (scope.serviceIds.length > 0) {
		const rows = (
			await Promise.all([
				db.query.applications.findMany({
					where: inArray(applications.applicationId, scope.serviceIds),
					columns: { applicationId: true },
					with: {
						environment: {
							columns: { environmentId: true },
							with: { project: { columns: { organizationId: true } } },
						},
					},
				}),
				db.query.compose.findMany({
					where: inArray(compose.composeId, scope.serviceIds),
					columns: { composeId: true },
					with: { environment: { with: { project: true } } },
				}),
				db.query.postgres.findMany({
					where: inArray(postgres.postgresId, scope.serviceIds),
					columns: { postgresId: true },
					with: { environment: { with: { project: true } } },
				}),
				db.query.mysql.findMany({
					where: inArray(mysql.mysqlId, scope.serviceIds),
					columns: { mysqlId: true },
					with: { environment: { with: { project: true } } },
				}),
				db.query.mariadb.findMany({
					where: inArray(mariadb.mariadbId, scope.serviceIds),
					columns: { mariadbId: true },
					with: { environment: { with: { project: true } } },
				}),
				db.query.mongo.findMany({
					where: inArray(mongo.mongoId, scope.serviceIds),
					columns: { mongoId: true },
					with: { environment: { with: { project: true } } },
				}),
				db.query.redis.findMany({
					where: inArray(redis.redisId, scope.serviceIds),
					columns: { redisId: true },
					with: { environment: { with: { project: true } } },
				}),
				db.query.libsql.findMany({
					where: inArray(libsql.libsqlId, scope.serviceIds),
					columns: { libsqlId: true },
					with: { environment: { with: { project: true } } },
				}),
			])
		).flat();
		if (
			rows.length !== new Set(scope.serviceIds).size ||
			rows.some(
				(service) =>
					service.environment.project.organizationId !== organizationId,
			)
		) {
			throw unauthorizedScope();
		}
	}
};

export const createApiCredentialScope = async ({
	apiKeyId,
	organizationId,
	scope,
}: {
	apiKeyId: string;
	organizationId: string;
	scope: ApiCredentialScopeInput;
}) => {
	await validateApiCredentialScope(organizationId, scope);
	const [created] = await db
		.insert(apiCredentialScopes)
		.values({ apiKeyId, organizationId, ...scope })
		.onConflictDoUpdate({
			target: apiCredentialScopes.apiKeyId,
			set: { ...scope, organizationId, updatedAt: new Date() },
		})
		.returning();
	if (!created) throw new Error("Failed to persist API credential scope");
	return created;
};

export const findApiCredentialScope = async (apiKeyId: string) =>
	(await db.query.apiCredentialScopes.findFirst({
		where: eq(apiCredentialScopes.apiKeyId, apiKeyId),
	})) ?? null;

const collectIds = (input: unknown) => {
	const ids = {
		projectIds: new Set<string>(),
		environmentIds: new Set<string>(),
		serviceIds: new Set<string>(),
	};
	const visit = (value: unknown) => {
		if (!value || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		for (const [key, entry] of Object.entries(value)) {
			if (typeof entry === "string") {
				if (key === "projectId") ids.projectIds.add(entry);
				if (key === "environmentId") ids.environmentIds.add(entry);
				if (
					key === "serviceId" ||
					key === "applicationId" ||
					key === "composeId" ||
					(key.endsWith("Id") &&
						[
							"postgresId",
							"mysqlId",
							"mariadbId",
							"mongoId",
							"redisId",
							"libsqlId",
						].includes(key))
				) {
					ids.serviceIds.add(entry);
				}
			} else {
				visit(entry);
			}
		}
	};
	visit(input);
	return ids;
};

const containsAll = (allowed: string[], requested: Set<string>) =>
	allowed.length === 0 || [...requested].every((id) => allowed.includes(id));

export const assertApiCredentialScope = (
	scope: ApiCredentialScope | null | undefined,
	resource: string,
	action: string,
	input: unknown,
) => {
	if (!scope) return;
	const allowed =
		scope.permissions.includes(`${resource}:*`) ||
		scope.permissions.includes(`${resource}:${action}`);
	if (!allowed) throw unauthorizedScope();
	const requested = collectIds(input);
	if (
		!containsAll(scope.projectIds, requested.projectIds) ||
		!containsAll(scope.environmentIds, requested.environmentIds) ||
		!containsAll(scope.serviceIds, requested.serviceIds)
	) {
		throw unauthorizedScope();
	}
};
