import sodium from 'libsodium-wrappers';
import { decompress } from 'fzstd';
import { z } from 'zod';
import type { Envelope } from './bindings/Envelope';

const FRAME = { sealed: 1, handshake: 2 } as const;
const NONCE_LENGTH = 24;
const ENCODING_JSON = 0;
const ENCODING_ZSTD = 1;
const REQUEST_LABEL = 'dbgopher/request';
const RESPONSE_LABEL = 'dbgopher/response';
const SESSION_LABEL = 'dbgopher/session';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const envelopeSchema = z.object({
	id: z.string(),
	sentAt: z.number(),
	body: z.unknown()
}) satisfies z.ZodType<Envelope<unknown>>;

export type Exchange = (sessionId: string, frame: Uint8Array) => Promise<Uint8Array>;

const concat = (...parts: Uint8Array[]) => {
	const joined = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
};

export const deriveKey = (sessionKey: Uint8Array, label: string) =>
	sodium.crypto_generichash(32, encoder.encode(label), sessionKey);

export const deriveSessionKey = (
	connectorKey: Uint8Array,
	sessionId: string,
	browserPublic: Uint8Array,
	connectorPublic: Uint8Array,
	shared: Uint8Array
) =>
	sodium.crypto_generichash(
		32,
		concat(
			encoder.encode(SESSION_LABEL),
			encoder.encode(sessionId),
			browserPublic,
			connectorPublic,
			shared
		),
		connectorKey
	);

export const handshakeFrame = (browserPublic: Uint8Array) =>
	concat(Uint8Array.of(FRAME.handshake), browserPublic);

export const seal = (
	key: Uint8Array,
	aad: Uint8Array,
	plaintext: Uint8Array,
	nonce = sodium.randombytes_buf(NONCE_LENGTH)
) => {
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		plaintext,
		aad,
		null,
		nonce,
		key
	);
	return concat(Uint8Array.of(FRAME.sealed), nonce, ciphertext);
};

export const open = (key: Uint8Array, aad: Uint8Array, sealed: Uint8Array) => {
	if (sealed[0] !== FRAME.sealed) throw new Error(`Unsupported envelope version ${sealed[0]}`);
	const nonce = sealed.subarray(1, 1 + NONCE_LENGTH);
	return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		sealed.subarray(1 + NONCE_LENGTH),
		aad,
		nonce,
		key
	);
};

export const encode = (envelope: Envelope<unknown>) => {
	const json = encoder.encode(JSON.stringify(envelope));
	const plaintext = new Uint8Array(1 + json.length);
	plaintext.set([ENCODING_JSON]);
	plaintext.set(json, 1);
	return plaintext;
};

export const decode = (plaintext: Uint8Array) => {
	const [encoding] = plaintext;
	if (encoding !== ENCODING_JSON && encoding !== ENCODING_ZSTD)
		throw new Error('Malformed envelope');
	const payload = plaintext.subarray(1);
	const json = encoding === ENCODING_ZSTD ? decompress(payload) : payload;
	return envelopeSchema.parse(JSON.parse(decoder.decode(json)));
};

export const createChannel = async (
	connectorKey: Uint8Array,
	connectorId: string,
	exchange: Exchange
) => {
	await sodium.ready;
	const sessionId = crypto.randomUUID();
	const secret = sodium.randombytes_buf(32);
	const browserPublic = sodium.crypto_scalarmult_base(secret);
	const connectorPublic = await exchange(sessionId, handshakeFrame(browserPublic));
	const shared = sodium.crypto_scalarmult(secret, connectorPublic);
	sodium.memzero(secret);
	const sessionKey = deriveSessionKey(
		connectorKey,
		sessionId,
		browserPublic,
		connectorPublic,
		shared
	);
	sodium.memzero(shared);
	const requestKey = deriveKey(sessionKey, REQUEST_LABEL);
	const responseKey = deriveKey(sessionKey, RESPONSE_LABEL);
	sodium.memzero(sessionKey);
	const aad = encoder.encode(connectorId);

	return {
		sessionId,
		sealRequest: (body: unknown) => {
			const envelope: Envelope<unknown> = { id: crypto.randomUUID(), sentAt: Date.now(), body };
			return { id: envelope.id, sealed: seal(requestKey, aad, encode(envelope)) };
		},
		openResponse: (id: string, sealed: Uint8Array) => {
			const envelope = decode(open(responseKey, aad, sealed));
			if (envelope.id !== id) throw new Error(`Expected a response to ${id}, got ${envelope.id}`);
			return envelope.body;
		}
	};
};
