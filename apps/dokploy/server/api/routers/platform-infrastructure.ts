import { isIP } from "node:net";
import {
	createPlatformBuildPool,
	createPlatformCluster,
	createPlatformNodePool,
	createPlatformRegion,
	createPlatformRuntimeTarget,
	listPlatformInfrastructure,
	updatePlatformBuildPool,
	updatePlatformCluster,
	updatePlatformRuntimeTarget,
} from "@dokploy/server/services/platform-infrastructure";
import { z } from "zod";
import { createTRPCRouter, platformAdminProcedure } from "../trpc";

const metadataSchema = z.record(z.string(), z.unknown()).default({});
const cidrSchema = z.string().refine((value) => {
	const [address, prefix] = value.split("/");
	const family = isIP(address || "");
	const bits = Number.parseInt(prefix || "", 10);
	return (
		(family === 4 && Number.isInteger(bits) && bits >= 0 && bits <= 32) ||
		(family === 6 && Number.isInteger(bits) && bits >= 0 && bits <= 128)
	);
}, "Invalid CIDR");
const clusterMetadataSchema = z.object({
	builderImage: z.string().min(1).optional(),
	inCluster: z.boolean().optional(),
	buildRuntimeClassName: z.string().min(1).optional(),
	runtimeClassName: z.string().min(1).optional(),
	gatewayNamespace: z.string().min(1).optional(),
	gatewayName: z.string().min(1).optional(),
	gatewaySectionName: z.string().min(1).optional(),
	gatewayClassName: z.string().min(1).optional(),
	registrySecretName: z.string().min(1).optional(),
	secretsEncryptionEnabled: z.boolean().optional(),
	networkPolicyEnabled: z.boolean().optional(),
	metricsServerEnabled: z.boolean().optional(),
	gatewayApiEnabled: z.boolean().optional(),
	certManagerEnabled: z.boolean().optional(),
	certIssuerName: z.string().min(1).optional(),
	allowedEgressCidrs: z.array(cidrSchema).max(50).optional(),
});
const targetStatusSchema = z.enum([
	"provisioning",
	"active",
	"draining",
	"error",
	"offline",
]);
const registryHostSchema = z
	.string()
	.regex(
		/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d{1,5})?$/,
		"Registry host must be hostname[:port] without a URL scheme",
	);
const registryRepositoryPrefixSchema = z
	.string()
	.regex(
		/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
		"Registry repository prefix must be a lowercase OCI path",
	);
const runtimeTargetChangesSchema = z.object({
	name: z.string().min(1).optional(),
	nodePoolId: z.string().min(1).nullable().optional(),
	status: targetStatusSchema.optional(),
	maxPlacements: z.number().int().min(1).optional(),
	weight: z.number().int().min(1).max(10_000).optional(),
	metadata: metadataSchema.optional(),
});
const buildPoolChangesSchema = z.object({
	name: z.string().min(1).optional(),
	nodePoolId: z.string().min(1).nullable().optional(),
	status: targetStatusSchema.optional(),
	builderImage: z.string().min(1).nullable().optional(),
	runtimeClassName: z.string().min(1).nullable().optional(),
	maxConcurrentBuilds: z.number().int().min(1).max(1_000).optional(),
	registryHost: registryHostSchema.nullable().optional(),
	registryRepositoryPrefix: registryRepositoryPrefixSchema
		.nullable()
		.optional(),
	registryAuthMode: z.enum(["basic", "workload_identity"]).optional(),
	registryUsername: z.string().min(1).nullable().optional(),
	registryPassword: z.string().min(1).nullable().optional(),
	runtimeRegistrySecretName: z.string().min(1).nullable().optional(),
	metadata: z
		.object({
			registryCredentialHelperConfigured: z.boolean().optional(),
			runtimeImagePullIdentityConfigured: z.boolean().optional(),
		})
		.optional(),
});

export const platformInfrastructureRouter = createTRPCRouter({
	all: platformAdminProcedure.query(() => listPlatformInfrastructure()),
	createRegion: platformAdminProcedure
		.input(
			z.object({
				slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				name: z.string().min(1),
				provider: z.string().min(1),
				location: z.string().min(1),
				status: z.enum(["active", "draining", "offline"]).optional(),
				isDefault: z.boolean().optional(),
				metadata: metadataSchema.optional(),
			}),
		)
		.mutation(({ input }) => createPlatformRegion(input)),
	createCluster: platformAdminProcedure
		.input(
			z.object({
				regionId: z.string().min(1),
				slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
				name: z.string().min(1),
				runtime: z.enum(["swarm", "kubernetes"]),
				status: z
					.enum(["provisioning", "active", "draining", "error", "offline"])
					.optional(),
				apiEndpoint: z.string().url().optional(),
				kubeconfig: z.string().min(1).optional(),
				isDefault: z.boolean().optional(),
				metadata: clusterMetadataSchema.default({}),
			}),
		)
		.mutation(({ input }) => createPlatformCluster(input)),
	updateCluster: platformAdminProcedure
		.input(
			z.object({
				clusterId: z.string().min(1),
				name: z.string().min(1).optional(),
				status: z
					.enum(["provisioning", "active", "draining", "error", "offline"])
					.optional(),
				apiEndpoint: z.string().url().nullable().optional(),
				kubeconfig: z.string().min(1).nullable().optional(),
				isDefault: z.boolean().optional(),
				metadata: clusterMetadataSchema.optional(),
			}),
		)
		.mutation(({ input }) => {
			const { clusterId, ...changes } = input;
			return updatePlatformCluster(clusterId, changes);
		}),
	createNodePool: platformAdminProcedure
		.input(
			z.object({
				clusterId: z.string().min(1),
				name: z.string().min(1),
				purpose: z.enum(["runtime", "build", "system"]),
				status: z.enum(["active", "draining", "offline"]).optional(),
				architecture: z.string().min(1).optional(),
				runtimeClassName: z.string().min(1).optional(),
				minNodes: z.number().int().min(0).optional(),
				maxNodes: z.number().int().min(1).optional(),
				labels: z.record(z.string(), z.string()).optional(),
				taints: z
					.array(
						z.object({
							key: z.string().min(1),
							value: z.string().optional(),
							effect: z.enum(["NoSchedule", "PreferNoSchedule", "NoExecute"]),
						}),
					)
					.optional(),
				metadata: metadataSchema.optional(),
			}),
		)
		.mutation(({ input }) => createPlatformNodePool(input)),
	createRuntimeTarget: platformAdminProcedure
		.input(
			z.object({
				clusterId: z.string().min(1),
				name: z.string().min(1),
				nodePoolId: z.string().min(1).optional(),
				status: targetStatusSchema.optional(),
				maxPlacements: z.number().int().min(1).optional(),
				weight: z.number().int().min(1).max(10_000).optional(),
				metadata: metadataSchema.optional(),
			}),
		)
		.mutation(({ input }) => createPlatformRuntimeTarget(input)),
	updateRuntimeTarget: platformAdminProcedure
		.input(
			runtimeTargetChangesSchema.extend({
				runtimeTargetId: z.string().min(1),
			}),
		)
		.mutation(({ input }) => {
			const { runtimeTargetId, ...changes } = input;
			return updatePlatformRuntimeTarget(runtimeTargetId, changes);
		}),
	createBuildPool: platformAdminProcedure
		.input(
			buildPoolChangesSchema.extend({
				clusterId: z.string().min(1),
				name: z.string().min(1),
				nodePoolId: z.string().min(1).optional(),
			}),
		)
		.mutation(({ input }) => createPlatformBuildPool(input)),
	updateBuildPool: platformAdminProcedure
		.input(buildPoolChangesSchema.extend({ buildPoolId: z.string().min(1) }))
		.mutation(({ input }) => {
			const { buildPoolId, ...changes } = input;
			return updatePlatformBuildPool(buildPoolId, changes);
		}),
});
