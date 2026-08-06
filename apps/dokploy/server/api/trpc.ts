/**
 * YOU PROBABLY DON'T NEED TO EDIT THIS FILE, UNLESS:
 * 1. You want to modify request context (see Part 1).
 * 2. You want to create a new middleware or type of procedure (see Part 3).
 *
 * TL;DR - This is where all the tRPC server stuff is created and plugged in. The pieces you will
 * need to use are documented accordingly near the end.
 */

import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
// import { getServerAuthSession } from "@/server/auth";
import { db } from "@dokploy/server/db";
import type { ApiCredentialScope } from "@dokploy/server/db/schema";
import { hasValidLicense } from "@dokploy/server/index";
import type { statements } from "@dokploy/server/lib/access-control";
import { validateRequest } from "@dokploy/server/lib/auth";
import { assertApiCredentialScope } from "@dokploy/server/services/api-credential-scope";
import { checkPermission } from "@dokploy/server/services/permission";
import { isPlatformAdmin } from "@dokploy/server/services/platform";
import type { OpenApiMeta } from "@dokploy/trpc-openapi";
import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateNextContextOptions } from "@trpc/server/adapters/next";
import type { Session, User } from "better-auth";
import superjson from "superjson";
import { ZodError } from "zod";
import { canUsePlatformOperatorSurface } from "./surface-policy";

type Resource = keyof typeof statements;
type ActionOf<R extends Resource> = (typeof statements)[R][number];

/**
 * 1. CONTEXT
 *
 * This section defines the "contexts" that are available in the backend API.
 *
 * These allow you to access things when processing a request, like the database, the session, etc.
 */

interface CreateContextOptions {
	surface?: "tenant" | "operator";
	user:
		| (User & {
				role: "member" | "admin" | "owner";
				ownerId: string;
				enableEnterpriseFeatures: boolean;
				isValidEnterpriseLicense: boolean;
		  })
		| null;
	session:
		| (Session & {
				activeOrganizationId: string;
				impersonatedBy?: string;
				apiKeyId?: string;
				apiCredentialScope?: ApiCredentialScope | null;
		  })
		| null;
	req: CreateNextContextOptions["req"];
	res: CreateNextContextOptions["res"];
}

/**
 * This helper generates the "internals" for a tRPC context. If you need to use it, you can export
 * it from here.
 *
 * Examples of things you may need it for:
 * - testing, so we don't have to mock Next.js' req/res
 * - tRPC's `createSSGHelpers`, where we don't have req/res
 *
 * @see https://create.t3.gg/en/usage/trpc#-serverapitrpcts
 */
const createInnerTRPCContext = (opts: CreateContextOptions) => {
	return {
		session: opts.session,
		db,
		req: opts.req,
		res: opts.res,
		user: opts.user,
		...(opts.surface ? { surface: opts.surface } : {}),
	};
};

/**
 * This is the actual context you will use in your router. It will be used to process every request
 * that goes through your tRPC endpoint.
 *
 * @see https://trpc.io/docs/context
 */
const createTRPCContextForSurface = async (
	opts: CreateNextContextOptions,
	surface: "tenant" | "operator",
) => {
	const { req, res } = opts;

	// Get from the request
	const { session, user } = await validateRequest(req);

	return createInnerTRPCContext({
		surface,
		req,
		res,
		// @ts-ignore
		session: session
			? {
					...session,
					activeOrganizationId: session.activeOrganizationId || "",
				}
			: null,
		// @ts-ignore
		user: user
			? {
					...user,
					email: user.email,
					role: user.role as "owner" | "member" | "admin",
					id: user.id,
					ownerId: user.ownerId,
				}
			: null,
	});
};

export const createTRPCContext = (opts: CreateNextContextOptions) =>
	createTRPCContextForSurface(opts, "tenant");

export const createOperatorTRPCContext = (opts: CreateNextContextOptions) =>
	createTRPCContextForSurface(opts, "operator");

/**
 * 2. INITIALIZATION
 *
 * This is where the tRPC API is initialized, connecting the context and transformer. We also parse
 * ZodErrors so that you get type safety on the frontend if your procedure fails due to validation
 * errors on the backend.
 */

const t = initTRPC
	.meta<OpenApiMeta>()
	.context<typeof createTRPCContext>()
	.create({
		transformer: superjson,
		errorFormatter({ shape, error }) {
			return {
				...shape,
				data: {
					...shape.data,
					zodError:
						error.cause instanceof ZodError ? error.cause.flatten() : null,
				},
			};
		},
	});

/**
 * 3. ROUTER & PROCEDURE (THE IMPORTANT BIT)
 *
 * These are the pieces you use to build your tRPC API. You should import these a lot in the
 * "/src/server/api/routers" directory.
 */

/**
 * This is how you create new routers and sub-routers in your tRPC API.
 *
 * @see https://trpc.io/docs/router
 */
export const createTRPCRouter = t.router;

/**
 * Public (unauthenticated) procedure
 *
 * This is the base piece you use to build new queries and mutations on your tRPC API. It does not
 * guarantee that a user querying is authorized, but you can still access user session data if they
 * are logged in.
 */
export const publicProcedure = t.procedure;

/**
 * Protected (authenticated) procedure
 *
 * If you want a query or mutation to ONLY be accessible to logged in users, use this. It verifies
 * the session is valid and guarantees `ctx.session.user` is not null.
 *
 * @see https://trpc.io/docs/procedures
 */
export const protectedProcedure = t.procedure.use(({ ctx, next, type }) => {
	if (!ctx.session || !ctx.user) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	assertApiCredentialScope(
		ctx.session.apiCredentialScope,
		"api",
		type === "mutation" ? "write" : "read",
		{},
	);
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: ctx.session,
			user: ctx.user,
			// session: { ...ctx.session, user: ctx.user },
		},
	});
});

/** Legacy host/container operations are not part of the managed tenant API. */
export const selfHostedProcedure = protectedProcedure.use(({ next }) => {
	if (IS_MANAGED_PAAS) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message:
				"Container databases are development-only; use managed data services",
		});
	}
	return next();
});

export const cliProcedure = t.procedure.use(({ ctx, next }) => {
	if (
		!ctx.session ||
		!ctx.user ||
		(ctx.user.role !== "owner" && ctx.user.role !== "admin")
	) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	assertApiCredentialScope(ctx.session.apiCredentialScope, "api", "admin", {});
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: ctx.session,
			user: ctx.user,
			// session: { ...ctx.session, user: ctx.user },
		},
	});
});

export const adminProcedure = t.procedure.use(({ ctx, next }) => {
	if (
		!ctx.session ||
		!ctx.user ||
		(ctx.user.role !== "owner" && ctx.user.role !== "admin")
	) {
		throw new TRPCError({ code: "UNAUTHORIZED" });
	}
	assertApiCredentialScope(ctx.session.apiCredentialScope, "api", "admin", {});
	return next({
		ctx: {
			// infers the `session` as non-nullable
			session: ctx.session,
			user: ctx.user,
			// session: { ...ctx.session, user: ctx.user },
		},
	});
});

/**
 * Global control-plane administrator. Unlike `adminProcedure`, organization
 * ownership does not grant this capability. Managed PaaS infrastructure must
 * never become tenant-accessible merely because a customer owns their org.
 */
export const platformAdminProcedure = protectedProcedure.use(
	async ({ ctx, next }) => {
		if (
			!canUsePlatformOperatorSurface({
				managed: IS_MANAGED_PAAS,
				surface: ctx.surface,
			})
		) {
			throw new TRPCError({ code: "NOT_FOUND" });
		}
		if (!(await isPlatformAdmin(ctx.user.id))) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Platform administrator access required",
			});
		}

		return next();
	},
);

/**
 * Requires admin/owner role AND enterprise enabled with a license key in DB.
 * Does NOT call the license server on every request; full validation (haveValidLicenseKey)
 * is used in the UI gate and when activating/validating keys.
 */
export const enterpriseProcedure = t.procedure.use(
	async ({ ctx, next, type }) => {
		if (
			!ctx.session ||
			!ctx.user ||
			(ctx.user.role !== "owner" && ctx.user.role !== "admin")
		) {
			throw new TRPCError({ code: "UNAUTHORIZED" });
		}
		assertApiCredentialScope(
			ctx.session.apiCredentialScope,
			"api",
			type === "mutation" ? "write" : "read",
			{},
		);

		const hasValidLicenseResult = await hasValidLicense(
			ctx.session.activeOrganizationId,
		);

		if (!hasValidLicenseResult) {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Valid enterprise license required",
			});
		}

		return next({
			ctx: {
				session: ctx.session,
				user: ctx.user,
			},
		});
	},
);

/**
 * Permission-checked procedure factory.
 *
 * Verifies the caller has the required resource+action permission before the
 * handler runs. Works for all role types:
 * - owner / admin  → always granted (static roles, no license needed)
 * - member         → legacy boolean fields (no license needed)
 * - custom role    → enterprise license verified automatically inside resolveRole
 *
 * Usage:
 *   create: withPermission("project", "create")
 *     .input(...)
 *     .mutation(async ({ ctx, input }) => { ... })
 */
export const withPermission = <R extends Resource>(
	resource: R,
	action: ActionOf<R>,
) =>
	protectedProcedure.use(async ({ ctx, next, getRawInput }) => {
		assertApiCredentialScope(
			ctx.session.apiCredentialScope,
			resource,
			action,
			await getRawInput(),
		);
		await checkPermission(ctx, { [resource]: [action] } as any);
		return next();
	});

export const selfHostedWithPermission = <R extends Resource>(
	resource: R,
	action: ActionOf<R>,
) =>
	selfHostedProcedure.use(async ({ ctx, next, getRawInput }) => {
		assertApiCredentialScope(
			ctx.session.apiCredentialScope,
			resource,
			action,
			await getRawInput(),
		);
		await checkPermission(ctx, { [resource]: [action] } as any);
		return next();
	});
