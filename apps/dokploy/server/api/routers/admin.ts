import {
	getWebServerSettings,
	IS_CLOUD,
	IS_MANAGED_PAAS,
	setupWebMonitoring,
	updateWebServerSettings,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { apiUpdateWebServerMonitoring } from "@/server/db/schema";
import {
	adminProcedure,
	createTRPCRouter,
	platformAdminProcedure,
} from "../trpc";

const infrastructureAdminProcedure = IS_MANAGED_PAAS
	? platformAdminProcedure
	: adminProcedure;

export const adminRouter = createTRPCRouter({
	setupMonitoring: infrastructureAdminProcedure
		.input(apiUpdateWebServerMonitoring)
		.mutation(async ({ input }) => {
			try {
				if (IS_CLOUD) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "Feature disabled on cloud",
					});
				}

				await updateWebServerSettings({
					metricsConfig: {
						server: {
							type: "Dokploy",
							refreshRate: input.metricsConfig.server.refreshRate,
							port: input.metricsConfig.server.port,
							token: input.metricsConfig.server.token,
							cronJob: input.metricsConfig.server.cronJob,
							urlCallback: input.metricsConfig.server.urlCallback,
							retentionDays: input.metricsConfig.server.retentionDays,
							thresholds: {
								cpu: input.metricsConfig.server.thresholds.cpu,
								memory: input.metricsConfig.server.thresholds.memory,
							},
						},
						containers: {
							refreshRate: input.metricsConfig.containers.refreshRate,
							services: {
								include: input.metricsConfig.containers.services.include || [],
								exclude: input.metricsConfig.containers.services.exclude || [],
							},
						},
					},
				});

				await setupWebMonitoring();
				const settings = await getWebServerSettings();
				return settings;
			} catch (error) {
				throw error;
			}
		}),
});
