import sodium from 'libsodium-wrappers';
import { decompress } from 'fzstd';
import { z } from 'zod';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { fromHex } from '../keys';
import type { Envelope } from './bindings/Envelope';

const ENCODING_JSON = 0;
const ENCODING_ZSTD = 1;
const KEY_CONFIG_VERSION = 2;
const REQUEST_VERSION = 4;
const KEY_CONFIG_LABEL = 'dbgopher/key-config';
const REQUEST_LABEL = 'dbgopher/request';
const REQUEST_SIGNATURE_LABEL = 'dbgopher/request-sig';
const RESPONSE_LABEL = 'dbgopher/response';
const PAIRING_LABEL = 'dbgopher/pair';
const KEY_LENGTH = 32;
const SIGNATURE_LENGTH = 64;
const RESPONSE_NONCE_LENGTH = 32;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const suite = new CipherSuite({
	kem: new DhkemX25519HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Chacha20Poly1305()
});

const hkdf = new HkdfSha256();

export const SUITE = Uint8Array.of(
	suite.kem.id >> 8,
	suite.kem.id,
	suite.kdf.id >> 8,
	suite.kdf.id,
	suite.aead.id >> 8,
	suite.aead.id
);

const KEY_CONFIG_LENGTH = 1 + 16 + SUITE.length + KEY_LENGTH + 8;

const envelopeSchema = z.object({
	id: z.string(),
	sentAt: z.number(),
	body: z.unknown()
}) satisfies z.ZodType<Envelope<unknown>>;

export type UserKey = { publicKey: Uint8Array; privateKey: Uint8Array };

export type KeyConfig = {
	prekey: Uint8Array;
	expiresAt: number;
	hash: Uint8Array;
};

export const concat = (...parts: Uint8Array[]) => {
	const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
};

const equal = (left: Uint8Array, right: Uint8Array) =>
	left.length === right.length && left.every((byte, index) => byte === right[index]);

export const uuidBytes = (id: string) => fromHex(id.replaceAll('-', ''));

const sha256 = async (bytes: Uint8Array) =>
	new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));

export const userKeyFromSeed = async (seed: Uint8Array): Promise<UserKey> => {
	await sodium.ready;
	const { publicKey, privateKey } = sodium.crypto_sign_seed_keypair(seed);
	return { publicKey, privateKey };
};

export const verifyKeyConfig = async (
	signed: Uint8Array,
	{ identityKey, connectorId, now }: { identityKey: Uint8Array; connectorId: string; now: number }
): Promise<KeyConfig | undefined> => {
	await sodium.ready;
	if (signed.length !== KEY_CONFIG_LENGTH + SIGNATURE_LENGTH) return undefined;
	const config = signed.subarray(0, KEY_CONFIG_LENGTH);
	const signature = signed.subarray(KEY_CONFIG_LENGTH);
	const message = concat(encoder.encode(KEY_CONFIG_LABEL), config);
	if (!sodium.crypto_sign_verify_detached(signature, message, identityKey)) return undefined;
	const suiteOffset = 1 + 16;
	const prekeyOffset = suiteOffset + SUITE.length;
	const expiresOffset = prekeyOffset + KEY_LENGTH;
	const expiresAt = Number(
		new DataView(config.buffer, config.byteOffset).getBigUint64(expiresOffset)
	);
	if (
		config[0] !== KEY_CONFIG_VERSION ||
		!equal(config.subarray(1, suiteOffset), uuidBytes(connectorId)) ||
		!equal(config.subarray(suiteOffset, prekeyOffset), SUITE) ||
		expiresAt <= now
	)
		return undefined;
	return {
		prekey: config.slice(prekeyOffset, expiresOffset),
		expiresAt,
		hash: await sha256(config)
	};
};

export const requestHeader = (keyConfig: KeyConfig, userKey: UserKey) =>
	concat(Uint8Array.of(REQUEST_VERSION), SUITE, keyConfig.hash, userKey.publicKey);

const openResponse = async (secret: Uint8Array, enc: Uint8Array, response: Uint8Array) => {
	const nonce = response.subarray(0, RESPONSE_NONCE_LENGTH);
	const prk = await hkdf.extract(concat(enc, nonce), secret);
	const key = new Uint8Array(await hkdf.expand(prk, encoder.encode('key'), KEY_LENGTH));
	const iv = new Uint8Array(await hkdf.expand(prk, encoder.encode('nonce'), 12));
	return sodium.crypto_aead_chacha20poly1305_ietf_decrypt(
		null,
		response.subarray(RESPONSE_NONCE_LENGTH),
		null,
		iv,
		key
	);
};

export const sealRequest = async (
	keyConfig: KeyConfig,
	userKey: UserKey,
	plaintext: Uint8Array,
	ekm?: Uint8Array
) => {
	await sodium.ready;
	const header = requestHeader(keyConfig, userKey);
	const sender = await suite.createSenderContext({
		recipientPublicKey: await suite.kem.deserializePublicKey(keyConfig.prekey),
		info: concat(encoder.encode(REQUEST_LABEL), Uint8Array.of(0), header),
		ekm
	});
	const ciphertext = new Uint8Array(await sender.seal(plaintext));
	const secret = new Uint8Array(await sender.export(encoder.encode(RESPONSE_LABEL), KEY_LENGTH));
	const enc = new Uint8Array(sender.enc);
	const signed = concat(header, enc, ciphertext);
	const signature = sodium.crypto_sign_detached(
		concat(encoder.encode(REQUEST_SIGNATURE_LABEL), signed),
		userKey.privateKey
	);
	return {
		frame: concat(signed, signature),
		open: (response: Uint8Array) => openResponse(secret, enc, response)
	};
};

export const verifyPairingProof = async (
	pairingSecret: Uint8Array,
	connectorId: string,
	identityKey: Uint8Array,
	proof: Uint8Array
) => {
	const key = await crypto.subtle.importKey(
		'raw',
		new Uint8Array(pairingSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['verify']
	);
	return crypto.subtle.verify(
		'HMAC',
		key,
		new Uint8Array(proof),
		concat(encoder.encode(PAIRING_LABEL), uuidBytes(connectorId), identityKey)
	);
};

export const encode = (envelope: Envelope<unknown>) =>
	concat(Uint8Array.of(ENCODING_JSON), encoder.encode(JSON.stringify(envelope)));

export const decode = (plaintext: Uint8Array) => {
	const [encoding] = plaintext;
	if (encoding !== ENCODING_JSON && encoding !== ENCODING_ZSTD)
		throw new Error('Malformed envelope');
	const payload = plaintext.subarray(1);
	const json = encoding === ENCODING_ZSTD ? decompress(payload) : payload;
	return envelopeSchema.parse(JSON.parse(decoder.decode(json)));
};
