import { z } from 'zod';

export const kdfParamsSchema = z.object({
	algorithm: z.literal('argon2id13'),
	opsLimit: z.int().min(1).max(16),
	memLimit: z
		.int()
		.min(8 * 1024 * 1024)
		.max(1024 * 1024 * 1024)
});

export type KdfParams = z.infer<typeof kdfParamsSchema>;

export const vaultRecordSchema = z.object({
	salt: z.base64().max(64),
	kdfParams: kdfParamsSchema,
	encryptedAccountKey: z.base64().max(256),
	encryptedContents: z.base64().max(512 * 1024)
});

export type VaultRecord = z.infer<typeof vaultRecordSchema>;

export const storedVaultSchema = vaultRecordSchema.extend({ revision: z.int().min(1) });

export type StoredVault = z.infer<typeof storedVaultSchema>;

export const vaultUpdateSchema = vaultRecordSchema.extend({ revision: z.int().min(0) });

export type VaultUpdate = z.infer<typeof vaultUpdateSchema>;
