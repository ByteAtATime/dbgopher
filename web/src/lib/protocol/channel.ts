import sodium from 'libsodium-wrappers';
import { decompress } from 'fzstd';
import { z } from 'zod';
import type { Envelope } from './bindings/Envelope';

const VERSION = 1;
const NONCE_LENGTH = 24;
const ENCODING_JSON = 0;
const ENCODING_ZSTD = 1;
const REQUEST_LABEL = 'dbgopher/request';
const RESPONSE_LABEL = 'dbgopher/response';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const envelopeSchema = z.object({
	id: z.string(),
	sentAt: z.number(),
	body: z.unknown()
}) satisfies z.ZodType<Envelope<unknown>>;

export const deriveKey = (connectorKey: Uint8Array, label: string) =>
	sodium.crypto_generichash(32, encoder.encode(label), connectorKey);

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
	const sealed = new Uint8Array(1 + NONCE_LENGTH + ciphertext.length);
	sealed.set([VERSION]);
	sealed.set(nonce, 1);
	sealed.set(ciphertext, 1 + NONCE_LENGTH);
	return sealed;
};

export const open = (key: Uint8Array, aad: Uint8Array, sealed: Uint8Array) => {
	if (sealed[0] !== VERSION) throw new Error(`Unsupported envelope version ${sealed[0]}`);
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

export const createChannel = async (connectorKey: Uint8Array, connectorId: string) => {
	await sodium.ready;
	const requestKey = deriveKey(connectorKey, REQUEST_LABEL);
	const responseKey = deriveKey(connectorKey, RESPONSE_LABEL);
	const aad = encoder.encode(connectorId);

	return {
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
