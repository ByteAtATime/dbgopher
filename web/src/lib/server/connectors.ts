import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
