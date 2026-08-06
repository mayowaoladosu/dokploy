import { randomUUID } from "node:crypto";
import { db } from "@dokploy/server/db";
import type { ApiCredentialScope } from "@dokploy/server/db/schema";
import {
	managedDataBackups,
	managedDataBindings,
	managedDataResources,
} from "@dokploy/server/db/schema";
import { assertApiCredentialScope } from "@dokploy/server/services/api-credential-scope";
import {
	createManagedDataBackup,
	deleteManagedDataBackup,
	listManagedDataBackups,
	refreshManagedDataBackup,
	restoreManagedDataBackup,
} from "@dokploy/server/services/managed-data-backup";
import {
	createManagedDataBinding,
	listManagedDataBindings,
	removeManagedDataBinding,
} from "@dokploy/server/services/managed-data-binding";
import {
	deleteManagedDataResource,
	filterManagedDataResourcesForScope,
	listManagedDataResources,
	listManagedDataServiceCatalog,
	managedDataPlans,
	provisionManagedDataResource,
	refreshManagedDataResource,
	rotateManagedDataCredentials,
} from "@dokploy/server/services/managed-data-provider";
import {
	checkPermission,
	checkServiceAccess,
	findMemberByUserId,
	type PermissionCtx,
} from "@dokploy/server/services/permission";
import {
	activatePlatformManagedDataProvider,
	createPlatformManagedDataProvider,
	listPlatformManagedDataProviders,
	updatePlatformManagedDataProvider,
} from "@dokploy/server/services/platform-managed-data";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
	createTRPCRouter,
	platformAdminProcedure,
	withPermission,
} from "../trpc";
import { audit } from "../utils/audit";

const resourceIdInput = z.object({ resourceId: z.string().min(1) });
const managedKind = z.enum([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"libsql",
]);
const providerCapabilities = z.object({
	highAvailability: z.boolean(),
	pooling: z.boolean(),
	pitr: z.boolean(),
	backups: z.boolean(),
	restore: z.boolean(),
	credentialRotation: z.boolean(),
	usage: z.boolean(),
	encryptionAtRest: z.literal(true),
	platformArchive: z.boolean(),
});
const providerMetadata = z.object({
	allowPrivateEndpoint: z.boolean().optional(),
	allowInsecure: z.boolean().optional(),
	healthPath: z.string().max(500).optional(),
	defaultRegions: z.record(z.string(), z.string()).optional(),
	planMappings: z.record(z.string(), z.string()).optional(),
});

const tenantManagedDataOperation = async <T>(
	operation: string,
	run: () => Promise<T>,
) => {
	try {
		return await run();
	} catch (error) {
		if (error instanceof TRPCError) throw error;
		const correlationId = randomUUID();
		console.error(`Managed data ${operation} failed [${correlationId}]`, error);
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Managed data operation failed (reference ${correlationId})`,
		});
	}
};

const assertResourceOrganization = async (
	resourceId: string,
	ctx: PermissionCtx,
	scope: ApiCredentialScope | null | undefined,
	permission: { resource: "managedData" | "backup"; action: string },
) => {
	const resource = await db.query.managedDataResources.findFirst({
		where: eq(managedDataResources.managedDataResourceId, resourceId),
		columns: { organizationId: true, projectId: true, environmentId: true },
	});
	if (
		!resource ||
		resource.organizationId !== ctx.session.activeOrganizationId
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data resource not found",
		});
	}
	assertApiCredentialScope(scope, permission.resource, permission.action, {
		projectId: resource.projectId,
		environmentId: resource.environmentId,
	});
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (
		member.role !== "owner" &&
		member.role !== "admin" &&
		!member.accessedProjects.includes(resource.projectId) &&
		!member.accessedEnvironments.includes(resource.environmentId)
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this managed data service",
		});
	}
};

const assertBackupOrganization = async (
	managedDataBackupId: string,
	ctx: PermissionCtx,
	scope: ApiCredentialScope | null | undefined,
	action: "read" | "create" | "delete" | "restore",
) => {
	const backup = await db.query.managedDataBackups.findFirst({
		where: eq(managedDataBackups.managedDataBackupId, managedDataBackupId),
		with: { resource: true },
	});
	if (
		!backup?.resource ||
		backup.resource.organizationId !== ctx.session.activeOrganizationId ||
		backup.kind !== "provider_snapshot"
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data backup not found",
		});
	}
	assertApiCredentialScope(scope, "backup", action, {
		projectId: backup.resource.projectId,
		environmentId: backup.resource.environmentId,
	});
	await assertResourceOrganization(
		backup.resource.managedDataResourceId,
		ctx,
		scope,
		{
			resource: "managedData",
			action:
				action === "read"
					? "read"
					: action === "restore"
						? "restore"
						: "backup",
		},
	);
};

const assertProvisionAccess = async (
	ctx: PermissionCtx,
	projectId: string,
	environmentId: string,
) => {
	assertApiCredentialScope(
		ctx.session.apiCredentialScope,
		"managedData",
		"create",
		{
			projectId,
			environmentId,
		},
	);
	const member = await findMemberByUserId(
		ctx.user.id,
		ctx.session.activeOrganizationId,
	);
	if (
		member.role !== "owner" &&
		member.role !== "admin" &&
		!member.accessedProjects.includes(projectId) &&
		!member.accessedEnvironments.includes(environmentId)
	) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this environment",
		});
	}
};

export const managedDataRouter = createTRPCRouter({
	platformProviders: platformAdminProcedure.query(() =>
		listPlatformManagedDataProviders(),
	),
	createPlatformProvider: platformAdminProcedure
		.input(
			z.object({
				name: z.string().min(1).max(100),
				type: z.enum(["neon", "upstash", "http"]),
				baseUrl: z.string().url(),
				credentials: z.record(z.string(), z.unknown()),
				kinds: z.array(managedKind).min(1).max(6),
				defaultKinds: z.array(managedKind).max(6).optional(),
				capabilities: providerCapabilities,
				metadata: providerMetadata.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const provider = await createPlatformManagedDataProvider(input);
			await audit(ctx, {
				action: "create",
				resourceType: "platform-managed-data-provider",
				resourceId: provider.managedDataProviderId,
				resourceName: provider.name,
			});
			return provider;
		}),
	updatePlatformProvider: platformAdminProcedure
		.input(
			z.object({
				managedDataProviderId: z.string().min(1),
				name: z.string().min(1).max(100).optional(),
				baseUrl: z.string().url().optional(),
				credentials: z.record(z.string(), z.unknown()).optional(),
				kinds: z.array(managedKind).min(1).max(6).optional(),
				defaultKinds: z.array(managedKind).max(6).optional(),
				capabilities: providerCapabilities.optional(),
				metadata: providerMetadata.optional(),
				status: z.enum(["provisioning", "error", "offline"]).optional(),
			}),
		)
		.mutation(async ({ ctx, input: { managedDataProviderId, ...input } }) => {
			const provider = await updatePlatformManagedDataProvider(
				managedDataProviderId,
				input,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "platform-managed-data-provider",
				resourceId: managedDataProviderId,
			});
			return provider;
		}),
	activatePlatformProvider: platformAdminProcedure
		.input(z.object({ managedDataProviderId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const provider = await activatePlatformManagedDataProvider(
				input.managedDataProviderId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "platform-managed-data-provider",
				resourceId: input.managedDataProviderId,
			});
			return provider;
		}),
	providers: withPermission("managedData", "read").query(() =>
		listManagedDataServiceCatalog(),
	),
	all: withPermission("managedData", "read").query(async ({ ctx }) => {
		const member = await findMemberByUserId(
			ctx.user.id,
			ctx.session.activeOrganizationId,
		);
		const resources = filterManagedDataResourcesForScope(
			await listManagedDataResources(ctx.session.activeOrganizationId),
			ctx.session.apiCredentialScope,
		);
		if (member.role === "owner" || member.role === "admin") return resources;
		return resources.filter(
			(resource) =>
				member.accessedProjects.includes(resource.projectId) ||
				member.accessedEnvironments.includes(resource.environmentId),
		);
	}),
	provision: withPermission("managedData", "create")
		.input(
			z.object({
				idempotencyKey: z.string().min(8).max(200),
				projectId: z.string().min(1),
				environmentId: z.string().min(1),
				kind: z.enum([
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"libsql",
				]),
				name: z.string().min(1).max(100),
				plan: z.enum(managedDataPlans),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProvisionAccess(ctx, input.projectId, input.environmentId);
			const resource = await tenantManagedDataOperation("provision", () =>
				provisionManagedDataResource({
					...input,
					organizationId: ctx.session.activeOrganizationId,
				}),
			);
			await audit(ctx, {
				action: "create",
				resourceType: "managed-data",
				resourceId: resource.managedDataResourceId,
				resourceName: resource.name,
			});
			return resource;
		}),
	refresh: withPermission("managedData", "operate")
		.input(resourceIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "operate" },
			);
			return tenantManagedDataOperation("refresh", () =>
				refreshManagedDataResource(input.resourceId),
			);
		}),
	rotateCredentials: withPermission("managedData", "rotate")
		.input(resourceIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "rotate" },
			);
			const result = await tenantManagedDataOperation("rotation", () =>
				rotateManagedDataCredentials(input.resourceId),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "managed-data-credentials",
				resourceId: input.resourceId,
			});
			return result;
		}),
	delete: withPermission("managedData", "delete")
		.input(resourceIdInput)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "delete" },
			);
			const result = await tenantManagedDataOperation("deletion", () =>
				deleteManagedDataResource(input.resourceId),
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "managed-data",
				resourceId: input.resourceId,
			});
			return result;
		}),
	bindings: withPermission("managedData", "read")
		.input(resourceIdInput)
		.query(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "read" },
			);
			return tenantManagedDataOperation("binding list", () =>
				listManagedDataBindings(
					input.resourceId,
					ctx.session.activeOrganizationId,
				),
			);
		}),
	bind: withPermission("managedData", "bind")
		.input(
			z.object({
				resourceId: z.string().min(1),
				applicationId: z.string().min(1),
				environmentVariable: z
					.string()
					.regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
					.default("DATABASE_URL"),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "bind" },
			);
			await checkServiceAccess(ctx, input.applicationId, "read");
			await checkPermission(ctx, { envVars: ["write"] });
			const binding = await tenantManagedDataOperation("binding", () =>
				createManagedDataBinding({
					managedDataResourceId: input.resourceId,
					applicationId: input.applicationId,
					organizationId: ctx.session.activeOrganizationId,
					environmentVariable: input.environmentVariable,
				}),
			);
			await audit(ctx, {
				action: "create",
				resourceType: "managed-data-binding",
				resourceId: binding.managedDataBindingId,
			});
			return binding;
		}),
	unbind: withPermission("managedData", "bind")
		.input(z.object({ bindingId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const binding = await db.query.managedDataBindings.findFirst({
				where: eq(managedDataBindings.managedDataBindingId, input.bindingId),
				with: { resource: true },
			});
			if (!binding?.resource) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Managed data binding was not found",
				});
			}
			await assertResourceOrganization(
				binding.resource.managedDataResourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "bind" },
			);
			await checkServiceAccess(ctx, binding.applicationId, "read");
			await checkPermission(ctx, { envVars: ["write"] });
			const result = await tenantManagedDataOperation("unbinding", () =>
				removeManagedDataBinding(
					input.bindingId,
					ctx.session.activeOrganizationId,
				),
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "managed-data-binding",
				resourceId: input.bindingId,
			});
			return result;
		}),
	backups: withPermission("managedData", "read")
		.input(resourceIdInput)
		.query(async ({ ctx, input }) => {
			await checkPermission(ctx, { backup: ["read"] });
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "read" },
			);
			return listManagedDataBackups(input.resourceId);
		}),
	backup: withPermission("managedData", "backup")
		.input(
			z.object({
				resourceId: z.string().min(1),
				idempotencyKey: z.string().min(8).max(200),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { backup: ["create"] });
			await assertResourceOrganization(
				input.resourceId,
				ctx,
				ctx.session.apiCredentialScope,
				{ resource: "managedData", action: "backup" },
			);
			const backup = await tenantManagedDataOperation("backup", () =>
				createManagedDataBackup({
					managedDataResourceId: input.resourceId,
					idempotencyKey: input.idempotencyKey,
				}),
			);
			await audit(ctx, {
				action: "create",
				resourceType: "managed-data-backup",
				resourceId: backup.managedDataBackupId,
			});
			return backup;
		}),
	refreshBackup: withPermission("managedData", "backup")
		.input(z.object({ backupId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { backup: ["read"] });
			await assertBackupOrganization(
				input.backupId,
				ctx,
				ctx.session.apiCredentialScope,
				"read",
			);
			return tenantManagedDataOperation("backup refresh", () =>
				refreshManagedDataBackup(input.backupId),
			);
		}),
	restoreBackup: withPermission("managedData", "restore")
		.input(z.object({ backupId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { backup: ["restore"] });
			await assertBackupOrganization(
				input.backupId,
				ctx,
				ctx.session.apiCredentialScope,
				"restore",
			);
			const result = await tenantManagedDataOperation("restore", () =>
				restoreManagedDataBackup(input.backupId),
			);
			await audit(ctx, {
				action: "restore",
				resourceType: "managed-data-backup",
				resourceId: input.backupId,
			});
			return result;
		}),
	deleteBackup: withPermission("managedData", "backup")
		.input(z.object({ backupId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await checkPermission(ctx, { backup: ["delete"] });
			await assertBackupOrganization(
				input.backupId,
				ctx,
				ctx.session.apiCredentialScope,
				"delete",
			);
			const result = await tenantManagedDataOperation("backup deletion", () =>
				deleteManagedDataBackup(input.backupId),
			);
			await audit(ctx, {
				action: "delete",
				resourceType: "managed-data-backup",
				resourceId: input.backupId,
			});
			return result;
		}),
});
