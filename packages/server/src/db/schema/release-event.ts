import { relations } from "drizzle-orm";
import {
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { releaseState, releases } from "./release";

export const releaseEventType = pgEnum("releaseEventType", [
	"created",
	"transitioned",
	"artifact_recorded",
	"health_checked",
	"rollback_requested",
	"reconciled",
]);

export const releaseEvents = pgTable(
	"release_event",
	{
		eventId: text("event_id")
			.primaryKey()
			.$defaultFn(() => nanoid()),
		releaseId: text("release_id")
			.notNull()
			.references(() => releases.releaseId, { onDelete: "cascade" }),
		eventType: releaseEventType("event_type").notNull(),
		fromState: releaseState("from_state"),
		toState: releaseState("to_state").notNull(),
		details: jsonb("details")
			.$type<Record<string, unknown>>()
			.notNull()
			.default({}),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		index("releaseEvent_releaseId_idx").on(table.releaseId),
		index("releaseEvent_createdAt_idx").on(table.createdAt),
	],
);

export const releaseEventRelations = relations(releaseEvents, ({ one }) => ({
	release: one(releases, {
		fields: [releaseEvents.releaseId],
		references: [releases.releaseId],
	}),
}));

export type ReleaseEvent = typeof releaseEvents.$inferSelect;
