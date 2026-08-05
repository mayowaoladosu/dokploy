import {
	getPublicWhitelabelingConfig,
	getWebServerSettings,
	hasValidLicense,
	IS_CLOUD,
	IS_MANAGED_PAAS,
	updateWebServerSettings,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { apiUpdateWhitelabeling } from "@/server/db/schema";
import {
	createTRPCRouter,
	enterpriseProcedure,
	platformAdminProcedure,
	protectedProcedure,
	publicProcedure,
} from "../../trpc";

const whitelabelAdminProcedure = IS_MANAGED_PAAS
	? platformAdminProcedure
	: enterpriseProcedure;

export const whitelabelingRouter = createTRPCRouter({
	get: protectedProcedure.query(async ({ ctx }) => {
		if (IS_CLOUD) {
			return null;
		}
		if (
			!IS_MANAGED_PAAS &&
			!(await hasValidLicense(ctx.session.activeOrganizationId))
		) {
			return null;
		}
		const settings = await getWebServerSettings();
		return settings?.whitelabelingConfig ?? null;
	}),

	update: whitelabelAdminProcedure
		.input(apiUpdateWhitelabeling)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Whitelabeling is not available in Cloud",
				});
			}

			if (!IS_MANAGED_PAAS && ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the owner can update whitelabeling settings",
				});
			}

			await updateWebServerSettings({
				whitelabelingConfig: input.whitelabelingConfig,
			});

			return { success: true };
		}),

	reset: whitelabelAdminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Whitelabeling is not available in Cloud",
			});
		}

		if (!IS_MANAGED_PAAS && ctx.user.role !== "owner") {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Only the owner can reset whitelabeling settings",
			});
		}

		await updateWebServerSettings({
			whitelabelingConfig: {
				appName: null,
				appDescription: null,
				logoUrl: null,
				faviconUrl: null,
				customCss: null,
				loginLogoUrl: null,
				supportUrl: null,
				docsUrl: null,
				errorPageTitle: null,
				errorPageDescription: null,
				metaTitle: null,
				footerText: null,
			},
		});

		return { success: true };
	}),

	// Public endpoint only for unauthenticated pages (login, register, error)
	// Returns only the fields needed for public pages
	getPublic: publicProcedure.query(() => getPublicWhitelabelingConfig()),
});
