import sodium from 'libsodium-wrappers-sumo';
import type { KdfParams } from './record';

export const deriveWrappingKey = async (password: string, salt: Uint8Array, params: KdfParams) => {
	await sodium.ready;
	return sodium.crypto_pwhash(
		32,
		password,
		salt,
		params.opsLimit,
		params.memLimit,
		sodium.crypto_pwhash_ALG_ARGON2ID13
	);
};
