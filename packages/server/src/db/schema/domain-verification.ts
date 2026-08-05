import { relations } from "drizzle-orm";
import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { domains } from "./domain";

export const domainVerificationStatus = pgEnum("domainVerificationStatus", [
	"pending",
	"verified",
	"failed",
]);

export const domainVerificationMethod = pgEnum("domainVerificationMethod", [
	"platform",
	"dns_txt",
]);

export const domainVerifications = pgTable(
	"domain_verification",
	{
		domainVerificationId: text("domain_verification_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		domainId: text("domain_id")
			.notNull()
			.references(() => domains.domainId, { onDelete: "cascade" }),
		status: domainVerificationStatus("status").notNull().default("pending"),
		method: domainVerificationMethod("method").notNull(),
		challengeName: text("challenge_name"),
		challengeValue: text("challenge_value"),
		errorMessage: text("error_message"),
		attempts: integer("attempts").notNull().default(0),
		lastCheckedAt: timestamp("last_checked_at"),
		verifiedAt: timestamp("verified_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("domainVerification_domainId_unique").on(table.domainId),
		index("domainVerification_status_idx").on(table.status),
	],
);

export const domainVerificationRelations = relations(
	domainVerifications,
	({ one }) => ({
		domain: one(domains, {
			fields: [domainVerifications.domainId],
			references: [domains.domainId],
		}),
	}),
);

export type DomainVerification = typeof domainVerifications.$inferSelect;
