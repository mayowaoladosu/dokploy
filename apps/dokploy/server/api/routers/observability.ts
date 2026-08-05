import {
	activatePlatformObservabilityBackend,
	createPlatformObservabilityBackend,
	findOrganizationObservabilityPolicy,
	listOrganizationObservabilityAudits,
	listPlatformObservabilityBackends,
	queryOrganizationObservability,
	updatePlatformObservabilityBackend,
	upsertOrganizationObservabilityPolicy,
} from "@dokploy/server/services/observability";
import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	platformAdminProcedure,
	protectedProcedure,
} from "../trpc";

const backendMetadata = z.object({
	allowInsecure: z.boolean().optional(),
	allowPrivateEndpoint: z.boolean().optional(),
	queryTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
	maxResponseBytes: z
		.number()
		.int()
		.min(1_024)
		.max(20 * 1024 * 1024)
		.optional(),
	retentionManagedExternally: z.boolean().optional(),
	healthEndpoint: z.string().url().optional(),
	otlpHeaders: z.record(z.string(), z.string()).optional(),
});

const policyInput = z.object({
	metricsRetentionDays: z.number().int().min(1).max(365),
	logsRetentionDays: z.number().int().min(1).max(365),
	tracesRetentionDays: z.number().int().min(1).max(365),
	queryEnabled: z.boolean().optional(),
	metadata: z.record(z.string(), z.unknown()).optional(),
});

export const observabilityRouter = createTRPCRouter({
	policy: protectedProcedure.query(({ ctx }) =>
		findOrganizationObservabilityPolicy(ctx.session.activeOrganizationId),
	),
	updatePolicy: adminProcedure.input(policyInput).mutation(({ ctx, input }) =>
		upsertOrganizationObservabilityPolicy({
			organizationId: ctx.session.activeOrganizationId,
			...input,
		}),
	),
	query: protectedProcedure
		.input(
			z.object({
				kind: z.enum(["metrics", "logs", "traces"]),
				start: z.coerce.date(),
				end: z.coerce.date(),
				metric: z.string().max(200).optional(),
				search: z.string().max(500).optional(),
				traceId: z.string().max(32).optional(),
				applicationId: z.string().max(200).optional(),
				deploymentId: z.string().max(200).optional(),
				stepSeconds: z.number().int().min(1).max(3_600).optional(),
			}),
		)
		.query(({ ctx, input }) =>
			queryOrganizationObservability({
				...input,
				organizationId: ctx.session.activeOrganizationId,
				userId: ctx.user.id,
			}),
		),
	auditLog: protectedProcedure
		.input(z.object({ limit: z.number().int().min(1).max(500).default(100) }))
		.query(({ ctx, input }) =>
			listOrganizationObservabilityAudits(
				ctx.session.activeOrganizationId,
				input.limit,
			),
		),
	listBackends: platformAdminProcedure.query(() =>
		listPlatformObservabilityBackends(),
	),
	createBackend: platformAdminProcedure
		.input(
			z.object({
				name: z.string().min(1).max(100),
				kind: z.enum(["prometheus", "loki", "tempo", "clickhouse", "otlp"]),
				endpoint: z.string().url(),
				authToken: z.string().min(1).max(8_192).nullable().optional(),
				tenantHeader: z.string().min(1).max(100).optional(),
				tenantId: z.string().min(1).max(200).optional(),
				metadata: backendMetadata.optional(),
			}),
		)
		.mutation(({ input }) => createPlatformObservabilityBackend(input)),
	updateBackend: platformAdminProcedure
		.input(
			z.object({
				observabilityBackendId: z.string().min(1),
				name: z.string().min(1).max(100).optional(),
				endpoint: z.string().url().optional(),
				authToken: z.string().min(1).max(8_192).nullable().optional(),
				tenantHeader: z.string().min(1).max(100).optional(),
				tenantId: z.string().min(1).max(200).optional(),
				isDefault: z.boolean().optional(),
				status: z.enum(["provisioning", "error", "offline"]).optional(),
				metadata: backendMetadata.optional(),
			}),
		)
		.mutation(({ input: { observabilityBackendId, ...input } }) =>
			updatePlatformObservabilityBackend(observabilityBackendId, input),
		),
	activateBackend: platformAdminProcedure
		.input(
			z.object({
				observabilityBackendId: z.string().min(1),
				makeDefault: z.boolean().default(true),
			}),
		)
		.mutation(({ input }) =>
			activatePlatformObservabilityBackend(
				input.observabilityBackendId,
				input.makeDefault,
			),
		),
});
