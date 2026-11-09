import { randomBytes, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db';
import { connector } from './db/schema';
import { hashToken } from './tokens';

const ENROLLMENT_TTL_MS = 60 * 60_000;
const KEY_LENGTH = 32;

const isUuid = (id: string) => z.uuid().safeParse(id).success;

const newToken = () => randomBytes(32).toString('base64url');

export const verifyConnector = async (id: string, token: string) => {
	if (!isUuid(id)) return false;
	const [row] = await db
		.select({ tokenHash: connector.tokenHash })
		.from(connector)
		.where(eq(connector.id, id));
	if (
		!row?.tokenHash ||
		!timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hashToken(token), 'hex'))
	)
		return false;
	await db
		.update(connector)
		.set({ enrollmentTokenHash: null, enrollmentExpiresAt: null })
		.where(and(eq(connector.id, id), isNotNull(connector.enrollmentTokenHash)));
	return true;
};

export const enrollConnector = async (
	id: string,
	enrollmentToken: string,
	identityKey: Uint8Array,
	proof: Uint8Array
) => {
	if (!isUuid(id) || identityKey.length !== KEY_LENGTH || proof.length !== KEY_LENGTH) return;
	const identity = Buffer.from(identityKey).toString('hex');
	const token = newToken();
	const [row] = await db
		.update(connector)
		.set({
			identityKey: identity,
			pairingProof: Buffer.from(proof).toString('hex'),
			tokenHash: hashToken(token)
		})
		.where(
			and(
				eq(connector.id, id),
				eq(connector.enrollmentTokenHash, hashToken(enrollmentToken)),
				gt(connector.enrollmentExpiresAt, new Date()),
				or(isNull(connector.identityKey), eq(connector.identityKey, identity))
			)
		)
		.returning({ id: connector.id });
	return row && token;
};

export const getEnrollment = async (userId: string, id: string) => {
	if (!isUuid(id)) return;
	const [row] = await db
		.select({ identityKey: connector.identityKey, proof: connector.pairingProof })
		.from(connector)
		.where(and(eq(connector.id, id), eq(connector.userId, userId)));
	return row;
};

export const ownsConnector = async (userId: string, id: string) => {
	if (!isUuid(id)) return false;
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
			environment: connector.environment,
			lastSeenAt: connector.lastSeenAt,
			createdAt: connector.createdAt
		})
		.from(connector)
		.where(eq(connector.userId, userId))
		.orderBy(desc(connector.createdAt));

export const createConnector = async (
	userId: string,
	name: string,
	environment: (typeof connector.$inferInsert)['environment']
) => {
	const enrollmentToken = newToken();
	const [{ id }] = await db
		.insert(connector)
		.values({
			userId,
			name,
			environment,
			enrollmentTokenHash: hashToken(enrollmentToken),
			enrollmentExpiresAt: new Date(Date.now() + ENROLLMENT_TTL_MS)
		})
		.returning({ id: connector.id });
	return { id, enrollmentToken };
};

export const markConnectorSeen = async (id: string, connectorVersion?: string) => {
	await db
		.update(connector)
		.set({ lastSeenAt: new Date(), connectorVersion })
		.where(eq(connector.id, id));
};
