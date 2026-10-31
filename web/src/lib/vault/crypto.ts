import sodium from 'libsodium-wrappers';
import { z } from 'zod';
import { deriveKey, open, seal } from '../protocol/channel';
import type { Kdf } from './kdf';
import type { KdfParams, VaultRecord } from './record';

export const KDF_PARAMS: KdfParams = {
	algorithm: 'argon2id13',
	opsLimit: 3,
	memLimit: 256 * 1024 * 1024
};

const SALT_LENGTH = 16;
const ACCOUNT_KEY_LENGTH = 32;
const ACCOUNT_KEY_LABEL = 'dbgopher/account-key';
const CONTENTS_LABEL = 'dbgopher/vault';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const contentsSchema = z.object({
	connectorKeys: z.record(z.string(), z.string()).default({})
});

export type Contents = z.infer<typeof contentsSchema>;

export class WrongPasswordError extends Error {
	constructor() {
		super('The unlock password does not match this vault.');
		this.name = 'WrongPasswordError';
	}
}

const toBase64 = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL);

const fromBase64 = (text: string) => sodium.from_base64(text, sodium.base64_variants.ORIGINAL);

const aad = (label: string, userId: string) => encoder.encode(`${label}:${userId}`);

export const sealContents = async (userId: string, accountKey: Uint8Array, contents: Contents) => {
	await sodium.ready;
	return toBase64(
		seal(
			deriveKey(accountKey, CONTENTS_LABEL),
			aad(CONTENTS_LABEL, userId),
			encoder.encode(JSON.stringify(contents))
		)
	);
};

export const openContents = async (userId: string, accountKey: Uint8Array, record: VaultRecord) => {
	await sodium.ready;
	return contentsSchema.parse(
		JSON.parse(
			decoder.decode(
				open(
					deriveKey(accountKey, CONTENTS_LABEL),
					aad(CONTENTS_LABEL, userId),
					fromBase64(record.encryptedContents)
				)
			)
		)
	);
};

export const createVault = async (userId: string, password: string, kdf: Kdf) => {
	await sodium.ready;
	const salt = sodium.randombytes_buf(SALT_LENGTH);
	const accountKey = sodium.randombytes_buf(ACCOUNT_KEY_LENGTH);
	const wrappingKey = await kdf(password, salt, KDF_PARAMS);
	const contents: Contents = { connectorKeys: {} };
	const record: VaultRecord = {
		salt: toBase64(salt),
		kdfParams: KDF_PARAMS,
		encryptedAccountKey: toBase64(seal(wrappingKey, aad(ACCOUNT_KEY_LABEL, userId), accountKey)),
		encryptedContents: await sealContents(userId, accountKey, contents)
	};
	return { accountKey, contents, record };
};

export const unlockAccountKey = async (
	userId: string,
	record: VaultRecord,
	password: string,
	kdf: Kdf
) => {
	await sodium.ready;
	const wrappingKey = await kdf(password, fromBase64(record.salt), record.kdfParams);
	try {
		return open(
			wrappingKey,
			aad(ACCOUNT_KEY_LABEL, userId),
			fromBase64(record.encryptedAccountKey)
		);
	} catch {
		throw new WrongPasswordError();
	}
};
