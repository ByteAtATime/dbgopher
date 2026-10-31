import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { user } from './auth.schema.ts';

export const connector = pgTable('connector', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	tokenHash: text('token_hash').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export * from './auth.schema.ts';
