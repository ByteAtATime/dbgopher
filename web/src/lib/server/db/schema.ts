import { integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { KdfParams } from '../../vault/record.ts';
import { user } from './auth.schema.ts';

export const connectorEnvironment = pgEnum('connector_environment', [
	'production',
	'staging',
	'development'
]);

export const connector = pgTable('connector', {
	id: uuid('id').primaryKey().defaultRandom(),
	userId: text('user_id')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	environment: connectorEnvironment('environment').notNull().default('production'),
	tokenHash: text('token_hash'),
	enrollmentTokenHash: text('enrollment_token_hash'),
	enrollmentExpiresAt: timestamp('enrollment_expires_at', { withTimezone: true }),
	identityKey: text('identity_key'),
	pairingProof: text('pairing_proof'),
	connectorVersion: text('connector_version'),
	lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
	createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
});

export const vault = pgTable('vault', {
	userId: text('user_id')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	salt: text('salt').notNull(),
	kdfParams: jsonb('kdf_params').$type<KdfParams>().notNull(),
	encryptedAccountKey: text('encrypted_account_key').notNull(),
	encryptedContents: text('encrypted_contents').notNull(),
	revision: integer('revision').notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

export * from './auth.schema.ts';
