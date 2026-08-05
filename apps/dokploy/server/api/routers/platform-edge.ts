import {
	createPlatformEdgeProvider,
	createPlatformObjectStorage,
	listPlatformEdgeInfrastructure,
	updatePlatformEdgeProvider,
	updatePlatformObjectStorage,
} from "@dokploy/server/services/platform-edge";
import { z } from "zod";
import { createTRPCRouter, platformAdminProcedure } from "../trpc";

const statusSchema = z.enum([
	"provisioning",
	"active",
	"draining",
	"error",
	"offline",
]);
const httpsUrlSchema = z
	.string()
	.url()
	.refine((value) => new URL(value).protocol === "https:", "HTTPS is required");
const edgeMetadataSchema = z.object({
	customHostnamesEnabled: z.boolean().optional(),
	managedWafEnabled: z.boolean().optional(),
	cacheEnabled: z.boolean().optional(),
	geoRoutingEnabled: z.boolean().optional(),
	originLockdownEnabled: z.boolean().optional(),
	authenticatedOriginPullsEnabled: z.boolean().optional(),
	analyticsEnabled: z.boolean().optional(),
	cacheTtlSeconds: z.number().int().min(1).max(31_536_000).optional(),
	browserTtlSeconds: z.number().int().min(0).max(31_536_000).optional(),
	loadBalancerPoolIds: z.array(z.string().min(8).max(128)).max(100).optional(),
	loadBalancerFallbackPoolId: z.string().min(8).max(128).optional(),
	loadBalancerRegionPools: z
		.record(
			z.string().min(2).max(32),
			z.array(z.string().min(8).max(128)).max(20),
		)
		.optional(),
});
const storageMetadataSchema = z.object({
	serverSideEncryption: z.enum(["AES256", "aws:kms"]).optional(),
	kmsKeyId: z.string().min(1).max(2_048).optional(),
	cacheControl: z.string().min(1).max(512).optional(),
});

const edgeCreateSchema = z.object({
	name: z.string().min(1).max(100),
	accountId: z.string().min(8).max(128),
	zoneId: z.string().min(8).max(128),
	zoneName: z.string().min(1).max(253),
	apiToken: z.string().min(20).max(2_048),
	originHostname: z.string().min(1).max(253),
	originToken: z.string().min(32).max(256),
	managedDomain: z.string().min(1).max(253),
	status: statusSchema.optional(),
	isDefault: z.boolean().optional(),
	metadata: edgeMetadataSchema.optional(),
});

const storageCreateSchema = z.object({
	name: z.string().min(1).max(100),
	provider: z.enum(["r2", "s3"]),
	endpoint: httpsUrlSchema,
	region: z.string().min(1).max(100),
	bucket: z.string().min(3).max(63),
	accessKeyId: z.string().min(1).max(2_048),
	secretAccessKey: z.string().min(1).max(2_048),
	publicBaseUrl: httpsUrlSchema,
	prefix: z.string().min(1).max(512).optional(),
	forcePathStyle: z.boolean().optional(),
	status: statusSchema.optional(),
	isDefault: z.boolean().optional(),
	metadata: storageMetadataSchema.optional(),
});

export const platformEdgeRouter = createTRPCRouter({
	all: platformAdminProcedure.query(() => listPlatformEdgeInfrastructure()),
	createEdgeProvider: platformAdminProcedure
		.input(edgeCreateSchema)
		.mutation(({ input }) => createPlatformEdgeProvider(input)),
	updateEdgeProvider: platformAdminProcedure
		.input(
			edgeCreateSchema.partial().extend({ edgeProviderId: z.string().min(1) }),
		)
		.mutation(({ input }) => {
			const { edgeProviderId, ...changes } = input;
			return updatePlatformEdgeProvider(edgeProviderId, changes);
		}),
	createObjectStorage: platformAdminProcedure
		.input(storageCreateSchema)
		.mutation(({ input }) => createPlatformObjectStorage(input)),
	updateObjectStorage: platformAdminProcedure
		.input(
			storageCreateSchema
				.partial()
				.extend({ objectStorageId: z.string().min(1) }),
		)
		.mutation(({ input }) => {
			const { objectStorageId, ...changes } = input;
			return updatePlatformObjectStorage(objectStorageId, changes);
		}),
});
