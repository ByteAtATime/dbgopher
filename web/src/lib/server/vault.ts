import { and, eq, sql } from 'drizzle-orm';
import type { StoredVault, VaultUpdate } from '../vault/record';
import { db } from './db';
import { vault } from './db/schema';

export const getVault = async (userId: string): Promise<StoredVault | undefined> => {
	const [row] = await db
		.select({
			salt: vault.salt,
			kdfParams: vault.kdfParams,
			encryptedAccountKey: vault.encryptedAccountKey,
			encryptedContents: vault.encryptedContents,
			revision: vault.revision
		})
		.from(vault)
		.where(eq(vault.userId, userId));
	return row;
};

export const putVault = async (userId: string, { revision, ...record }: VaultUpdate) => {
	const [row] =
		revision === 0
			? await db
					.insert(vault)
					.values({ userId, ...record, revision: 1 })
					.onConflictDoNothing()
					.returning({ revision: vault.revision })
			: await db
					.update(vault)
					.set({ ...record, revision: revision + 1, updatedAt: sql`now()` })
					.where(and(eq(vault.userId, userId), eq(vault.revision, revision)))
					.returning({ revision: vault.revision });
	return row?.revision;
};
