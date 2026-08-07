import {
	index,
	integer,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const polarWebhookStatus = pgEnum("polarWebhookStatus", [
	"processing",
	"processed",
	"failed",
]);

export const polarWebhookEvents = pgTable(
	"polar_webhook_event",
	{
		polarWebhookEventId: text("polar_webhook_event_id").primaryKey(),
		type: text("type").notNull(),
		payloadTimestamp: timestamp("payload_timestamp").notNull(),
		status: polarWebhookStatus("status").notNull().default("processing"),
		attempts: integer("attempts").notNull().default(1),
		lastError: text("last_error"),
		processedAt: timestamp("processed_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [
		index("polarWebhookEvent_statusUpdated_idx").on(
			table.status,
			table.updatedAt,
		),
	],
);

export type PolarWebhookEvent = typeof polarWebhookEvents.$inferSelect;
