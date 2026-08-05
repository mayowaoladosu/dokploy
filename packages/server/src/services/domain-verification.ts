import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type DomainVerification,
	domains,
	domainVerifications,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";

const managedAppsDomain = () =>
	process.env.PLATFORM_APPS_DOMAIN?.trim()
		.toLowerCase()
		.replace(/^\*\./, "")
		.replace(/^\.+|\.+$/g, "") || null;

export const isPlatformManagedHostname = (host: string) => {
	const base = managedAppsDomain();
	const normalized = host.trim().toLowerCase().replace(/\.$/, "");
	return Boolean(
		base && (normalized === base || normalized.endsWith(`.${base}`)),
	);
};

const challengeFor = (host: string) => ({
	challengeName: `_vlyv-verification.${host.trim().toLowerCase().replace(/\.$/, "")}`,
	challengeValue: randomBytes(24).toString("base64url"),
});

export const initializeDomainVerification = async (domain: {
	domainId: string;
	host: string;
}) => {
	const platformManaged = isPlatformManagedHostname(domain.host);
	const challenge = platformManaged ? null : challengeFor(domain.host);
	const now = new Date();
	const [verification] = await db
		.insert(domainVerifications)
		.values({
			domainId: domain.domainId,
			status: platformManaged ? "verified" : "pending",
			method: platformManaged ? "platform" : "dns_txt",
			challengeName: challenge?.challengeName,
			challengeValue: challenge?.challengeValue,
			verifiedAt: platformManaged ? now : null,
			lastCheckedAt: platformManaged ? now : null,
		})
		.onConflictDoUpdate({
			target: domainVerifications.domainId,
			set: {
				status: platformManaged ? "verified" : "pending",
				method: platformManaged ? "platform" : "dns_txt",
				challengeName: challenge?.challengeName ?? null,
				challengeValue: challenge?.challengeValue ?? null,
				errorMessage: null,
				attempts: 0,
				verifiedAt: platformManaged ? now : null,
				lastCheckedAt: platformManaged ? now : null,
				updatedAt: now,
			},
		})
		.returning();
	if (!verification)
		throw new Error("Failed to initialize domain verification");
	return verification;
};

export const findDomainVerification = async (domainId: string) =>
	(await db.query.domainVerifications.findFirst({
		where: eq(domainVerifications.domainId, domainId),
	})) ?? null;

export const isDomainVerified = async (domainId: string) =>
	(await findDomainVerification(domainId))?.status === "verified";

export const verifyDomainOwnership = async (
	domainId: string,
	resolveTxt: typeof dns.resolveTxt = dns.resolveTxt,
): Promise<DomainVerification> => {
	if (!IS_MANAGED_PAAS) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Managed domain verification is not enabled",
		});
	}
	const domain = await db.query.domains.findFirst({
		where: eq(domains.domainId, domainId),
	});
	if (!domain) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Domain not found" });
	}
	let verification = await findDomainVerification(domainId);
	if (!verification) {
		verification = await initializeDomainVerification(domain);
	}
	if (verification.status === "verified") return verification;
	const now = new Date();
	try {
		const values = (await resolveTxt(verification.challengeName || "")).map(
			(segments) => segments.join(""),
		);
		const verified = values.includes(verification.challengeValue || "");
		const [updated] = await db
			.update(domainVerifications)
			.set({
				status: verified ? "verified" : "failed",
				errorMessage: verified
					? null
					: "DNS TXT verification value was not found",
				attempts: verification.attempts + 1,
				lastCheckedAt: now,
				verifiedAt: verified ? now : null,
				updatedAt: now,
			})
			.where(eq(domainVerifications.domainId, domainId))
			.returning();
		if (!updated) throw new Error("Failed to update domain verification");
		return updated;
	} catch (error) {
		const [updated] = await db
			.update(domainVerifications)
			.set({
				status: "failed",
				errorMessage: error instanceof Error ? error.message : String(error),
				attempts: verification.attempts + 1,
				lastCheckedAt: now,
				updatedAt: now,
			})
			.where(eq(domainVerifications.domainId, domainId))
			.returning();
		if (!updated) throw error;
		return updated;
	}
};

export const findVerifiedDomainsByApplicationId = async (
	applicationId: string,
) =>
	db
		.select({
			domainId: domains.domainId,
			host: domains.host,
			path: domains.path,
			port: domains.port,
			https: domains.https,
		})
		.from(domains)
		.innerJoin(
			domainVerifications,
			eq(domainVerifications.domainId, domains.domainId),
		)
		.where(
			and(
				eq(domains.applicationId, applicationId),
				eq(domainVerifications.status, "verified"),
			),
		);

export const reconcileDomainVerifications = async () => {
	if (!IS_MANAGED_PAAS) return 0;
	const existing = new Set(
		(
			await db.query.domainVerifications.findMany({
				columns: { domainId: true },
			})
		).map((verification) => verification.domainId),
	);
	const missing = (await db.query.domains.findMany()).filter(
		(domain) => !existing.has(domain.domainId),
	);
	for (const domain of missing) {
		await initializeDomainVerification(domain);
	}
	return missing.length;
};
