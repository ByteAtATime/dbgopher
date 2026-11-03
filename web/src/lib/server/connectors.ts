import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { connector } from './db/schema';
import { hashToken } from './tokens';

export const verifyConnector = async (id: string, token: string) => {
	if (!z.uuid().safeParse(id).success) return false;
	const [row] = await db
		.select({ tokenHash: connector.tokenHash })
		.from(connector)
		.where(eq(connector.id, id));
	return (
		row !== undefined &&
		timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'))
	);
};

export const ownsConnector = async (userId: string, id: string) => {
	if (!z.uuid().safeParse(id).success) return false;
	const [row] = await db
		.select({ id: connector.id })
		.from(connector)
		.where(and(eq(connector.id, id), eq(connector.userId, userId)));
	return row !== undefined;
};

export const listConnectors = (userId: string) =>
	db
		.select({
			id: connector.id,
			name: connector.name,
			lastSeenAt: connector.lastSeenAt,
			createdAt: connector.createdAt
		})
		.from(connector)
		.where(eq(connector.userId, userId))
		.orderBy(desc(connector.createdAt));

export const createConnector = async (userId: string, name: string) => {
	const token = randomBytes(32).toString('base64url');
	const [{ id }] = await db
		.insert(connector)
		.values({ userId, name, tokenHash: hashToken(token) })
		.returning({ id: connector.id });
	return { id, token };
};

export const markConnectorSeen = async (id: string, connectorVersion?: string) => {
	await db
		.update(connector)
		.set({ lastSeenAt: new Date(), connectorVersion })
		.where(eq(connector.id, id));
};
