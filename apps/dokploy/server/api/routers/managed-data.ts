import { db } from "@dokploy/server/db";
import type { ApiCredentialScope } from "@dokploy/server/db/schema";
import { managedDataResources } from "@dokploy/server/db/schema";
import { assertApiCredentialScope } from "@dokploy/server/services/api-credential-scope";
import {
	deleteManagedDataResource,
	filterManagedDataResourcesForScope,
	listManagedDataResources,
	provisionManagedDataResource,
	refreshManagedDataResource,
	rotateManagedDataCredentials,
} from "@dokploy/server/services/managed-data-provider";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createTRPCRouter, withPermission } from "../trpc";

const resourceIdInput = z.object({ resourceId: z.string().min(1) });

const assertResourceOrganization = async (
	resourceId: string,
	organizationId: string,
	scope: ApiCredentialScope | null | undefined,
	action: "read" | "create" | "delete",
) => {
	const resource = await db.query.managedDataResources.findFirst({
		where: eq(managedDataResources.managedDataResourceId, resourceId),
		columns: { organizationId: true, projectId: true, environmentId: true },
	});
	if (!resource || resource.organizationId !== organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data resource not found",
		});
	}
	assertApiCredentialScope(scope, "service", action, {
		projectId: resource.projectId,
		environmentId: resource.environmentId,
	});
};

export const managedDataRouter = createTRPCRouter({
	all: withPermission("service", "read").query(async ({ ctx }) =>
		filterManagedDataResourcesForScope(
			await listManagedDataResources(ctx.session.activeOrganizationId),
			ctx.session.apiCredentialScope,
		),
	),
	provision: withPermission("service", "create")
		.input(
			z.object({
				provider: z.string().min(1).default("default"),
				idempotencyKey: z.string().min(8).max(200),
				projectId: z.string().min(1),
				environmentId: z.string().min(1),
				regionId: z.string().min(1).optional(),
				kind: z.enum([
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"libsql",
				]),
				name: z.string().min(1).max(100),
				plan: z.string().min(1).max(100),
				metadata: z.record(z.string(), z.unknown()).optional(),
			}),
		)
		.mutation(({ ctx, input }) => {
			const { provider, ...request } = input;
			return provisionManagedDataResource(provider, {
				...request,
				organizationId: ctx.session.activeOrganizationId,
			});
		}),
	refresh: withPermission("service", "read")
		.input(resourceIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx.session.activeOrganizationId,
				ctx.session.apiCredentialScope,
				"read",
			);
			return refreshManagedDataResource(input.resourceId);
		}),
	rotateCredentials: withPermission("service", "create")
		.input(resourceIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx.session.activeOrganizationId,
				ctx.session.apiCredentialScope,
				"create",
			);
			return rotateManagedDataCredentials(input.resourceId);
		}),
	delete: withPermission("service", "delete")
		.input(resourceIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx.session.activeOrganizationId,
				ctx.session.apiCredentialScope,
				"delete",
			);
			return deleteManagedDataResource(input.resourceId);
		}),
});
