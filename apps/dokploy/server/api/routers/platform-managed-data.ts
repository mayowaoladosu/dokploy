import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import {
	activatePlatformManagedDataProvider,
	createPlatformManagedDataProvider,
	listPlatformManagedDataProviders,
	updatePlatformManagedDataProvider,
} from "@dokploy/server/services/platform-managed-data";
import { z } from "zod";
import { createTRPCRouter, platformAdminProcedure } from "../trpc";
import { audit } from "../utils/audit";

const managedKind = z.literal("postgres");
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

export const platformManagedDataRouter = createTRPCRouter({
	platformProviders: platformAdminProcedure.query(() =>
		listPlatformManagedDataProviders(),
	),
	createPlatformProvider: platformAdminProcedure
		.input(
			z.object({
				name: z.string().min(1).max(100),
				type: IS_MANAGED_PAAS ? z.literal("neon") : z.enum(["neon", "http"]),
				baseUrl: z.string().url(),
				credentials: z.record(z.string(), z.unknown()),
				kinds: z.tuple([managedKind]),
				defaultKinds: z.tuple([managedKind]).optional(),
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
				kinds: z.tuple([managedKind]).optional(),
				defaultKinds: z.tuple([managedKind]).optional(),
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
});
