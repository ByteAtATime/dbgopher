import { describe, expect, it } from 'vitest';
import { deriveWrappingKey } from './argon2';
import {
	createVault,
	openContents,
	sealContents,
	unlockAccountKey,
	WrongPasswordError,
	type Contents
} from './crypto';
import { vaultRecordSchema } from './record';

const PASSWORD = 'correct horse battery staple';

describe('vault', () => {
	it('unlocks the account key with the unlock password', async () => {
		const { accountKey, contents, record } = await createVault(
			'user-1',
			PASSWORD,
			deriveWrappingKey
		);
		expect(vaultRecordSchema.parse(record)).toEqual(record);
		expect(await unlockAccountKey('user-1', record, PASSWORD, deriveWrappingKey)).toEqual(
			accountKey
		);
		expect(await openContents('user-1', accountKey, record)).toEqual(contents);
		expect(contents).toEqual({ userKey: expect.stringMatching(/^[0-9a-f]{64}$/), connectors: {} });
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

	it('round-trips the user key and connectors', async () => {
		const { accountKey, record } = await createVault('user-1', PASSWORD, deriveWrappingKey);
		const contents: Contents = {
			userKey: 'cd'.repeat(32),
			connectors: {
				'connector-1': { state: 'paired', identityKey: 'ab'.repeat(32) },
				'connector-2': { state: 'pairing', pairingSecret: 'ef'.repeat(32) }
			}
		};
		const encryptedContents = await sealContents('user-1', accountKey, contents);
		expect(await openContents('user-1', accountKey, { ...record, encryptedContents })).toEqual(
			contents
		);
	});
});
