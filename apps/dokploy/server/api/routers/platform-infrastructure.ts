import { isIP } from "node:net";
import {
	createPlatformCluster,
	createPlatformNodePool,
	createPlatformRegion,
	listPlatformInfrastructure,
	updatePlatformCluster,
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
});
