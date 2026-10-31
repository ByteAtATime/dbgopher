import { describe, expect, it } from 'vitest';
import { deriveWrappingKey } from './argon2';
import {
	createVault,
	openContents,
	sealContents,
	unlockAccountKey,
	WrongPasswordError
} from './crypto';
import { vaultRecordSchema } from './record';

const PASSWORD = 'correct horse battery staple';

describe('vault', () => {
	it('unlocks the account key with the unlock password', async () => {
		const { accountKey, record } = await createVault('user-1', PASSWORD, deriveWrappingKey);
		expect(vaultRecordSchema.parse(record)).toEqual(record);
		expect(await unlockAccountKey('user-1', record, PASSWORD, deriveWrappingKey)).toEqual(
			accountKey
		);
		expect(await openContents('user-1', accountKey, record)).toEqual({ connectorKeys: {} });
	});

	it('rejects a wrong password', async () => {
		const { record } = await createVault('user-1', PASSWORD, deriveWrappingKey);
		await expect(unlockAccountKey('user-1', record, 'wrong', deriveWrappingKey)).rejects.toThrow(
			WrongPasswordError
		);
	});

	it('binds the vault to its user', async () => {
		const { accountKey, record } = await createVault('user-1', PASSWORD, deriveWrappingKey);
		await expect(unlockAccountKey('user-2', record, PASSWORD, deriveWrappingKey)).rejects.toThrow(
			WrongPasswordError
		);
		await expect(openContents('user-2', accountKey, record)).rejects.toThrow();
	});

	it('round-trips connector keys', async () => {
		const { accountKey, record } = await createVault('user-1', PASSWORD, deriveWrappingKey);
		const contents = { connectorKeys: { 'connector-1': 'ab'.repeat(32) } };
		const encryptedContents = await sealContents('user-1', accountKey, contents);
		expect(await openContents('user-1', accountKey, { ...record, encryptedContents })).toEqual(
			contents
		);
	});
});
