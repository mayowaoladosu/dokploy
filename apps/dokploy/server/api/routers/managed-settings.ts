import { db } from "@dokploy/server/db";
import { projects } from "@dokploy/server/db/schema";
import { eq, sql } from "drizzle-orm";
import openApiDocument from "../../../../../openapi.json";
import packageInfo from "../../../package.json";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";

/** Minimal settings contract required by managed tenant pages. */
export const managedSettingsRouter = createTRPCRouter({
	getWebServerSettings: protectedProcedure.query(() => null),
	getIp: protectedProcedure.query(() => ""),
	getDokployVersion: protectedProcedure.query(() => packageInfo.version),
	isCloud: publicProcedure.query(() => true),
	platformCapabilities: protectedProcedure.query(() => ({
		mode: "managed" as const,
		canManageInfrastructure: false,
	})),
	isUserSubscribed: protectedProcedure.query(async ({ ctx }) => {
		const project = await db.query.projects.findFirst({
			where: eq(projects.organizationId, ctx.session.activeOrganizationId),
			columns: { projectId: true },
		});
		return Boolean(project);
	}),
	health: publicProcedure.query(async () => {
		try {
			await db.execute(sql`SELECT 1`);
			return { status: "ok" as const };
		} catch {
			return { status: "error" as const };
		}
	}),
	getOpenApiDocument: protectedProcedure.query((): unknown => openApiDocument),
});
