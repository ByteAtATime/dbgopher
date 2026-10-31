import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const connector = pgTable('connector', {
	id: uuid('id').primaryKey().defaultRandom(),
	tokenHash: text('token_hash').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});
