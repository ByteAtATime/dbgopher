import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from '../../../../protocol/vectors.json';
import {
	createChannel,
	decode,
	deriveKey,
	deriveSessionKey,
	encode,
	open,
	requestHeader,
	seal
} from './channel';

const { prekey } = vectors;
const HEADER_LENGTH = 65;
const connectorKey = () => sodium.from_hex(vectors.connectorKey);
const prekeyPublic = () => sodium.from_hex(prekey.prekeyPublic);
const aad = () => new TextEncoder().encode(vectors.connectorId);

beforeAll(() => sodium.ready);

const connect = (connectorId = vectors.connectorId) =>
	createChannel(connectorKey(), connectorId, prekeyPublic());

const connectorKeys = (sealed: Uint8Array) => {
	const browserPublic = sealed.subarray(33, HEADER_LENGTH);
	const sessionKey = deriveSessionKey(
		connectorKey(),
		browserPublic,
		prekeyPublic(),
		sodium.crypto_scalarmult(sodium.from_hex(prekey.prekeySecret), browserPublic)
	);
	return {
		request: deriveKey(sessionKey, 'dbgopher/request'),
		response: deriveKey(sessionKey, 'dbgopher/response')
	};
};

describe('vectors', () => {
	it('derives the session key from the prekey', () => {
		const browserSecret = sodium.from_hex(prekey.browserSecret);
		expect(sodium.to_hex(sodium.crypto_scalarmult_base(browserSecret))).toBe(prekey.browserPublic);
		const shared = sodium.crypto_scalarmult(browserSecret, prekeyPublic());
		expect(sodium.to_hex(shared)).toBe(prekey.shared);
		const sessionKey = deriveSessionKey(
			connectorKey(),
			sodium.from_hex(prekey.browserPublic),
			prekeyPublic(),
			shared
		);
		expect(sodium.to_hex(sessionKey)).toBe(prekey.sessionKey);
	});

	it('encodes the request header', () => {
		expect(
			sodium.to_hex(requestHeader(prekeyPublic(), sodium.from_hex(prekey.browserPublic)))
		).toBe(prekey.header);
	});

	it('derives the per-direction keys', () => {
		const sessionKey = sodium.from_hex(prekey.sessionKey);
		expect(sodium.to_hex(deriveKey(sessionKey, 'dbgopher/request'))).toBe(vectors.requestKey);
		expect(sodium.to_hex(deriveKey(sessionKey, 'dbgopher/response'))).toBe(vectors.responseKey);
	});

	it.each(vectors.messages)('matches the $direction vector', (message) => {
		const key = sodium.from_hex(
			message.direction === 'request' ? vectors.requestKey : vectors.responseKey
		);
		const plaintext = sodium.from_hex(message.plaintext);
		const sealed = seal(key, aad(), plaintext, sodium.from_hex(message.nonce));
		expect(sodium.to_hex(sealed)).toBe(message.sealed);
		expect(sodium.to_hex(open(key, aad(), sealed))).toBe(message.plaintext);
		expect(decode(plaintext)).toEqual(message.envelope);
	});
});

describe('createChannel', () => {
	it('seals requests the connector can open under a fresh ephemeral key', async () => {
		const first = (await connect()).sealRequest({ message: 'hello' });
		const second = (await connect()).sealRequest({ message: 'hello' });
		const header = first.sealed.subarray(0, HEADER_LENGTH);
		expect(sodium.to_hex(header)).toBe(
			sodium.to_hex(requestHeader(prekeyPublic(), header.subarray(33)))
		);
		expect(second.sealed.subarray(0, HEADER_LENGTH)).not.toEqual(header);
		const request = connectorKeys(first.sealed).request;
		expect(decode(open(request, aad(), first.sealed.subarray(HEADER_LENGTH)))).toMatchObject({
			id: first.id,
			body: { message: 'hello' }
		});
	});

	it('opens responses only for the request they answer', async () => {
		const channel = await connect();
		const { sealed } = channel.sealRequest({ message: 'hello' });
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: 'pong' };
		const response = seal(connectorKeys(sealed).response, aad(), encode(envelope));
		expect(channel.openResponse(envelope.id, response)).toBe('pong');
		expect(() => channel.openResponse(crypto.randomUUID(), response)).toThrow();
	});

	it('rejects responses sealed for another connector', async () => {
		const channel = await connect('another-connector');
		const { sealed } = channel.sealRequest({ message: 'hello' });
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: 'pong' };
		const response = seal(connectorKeys(sealed).response, aad(), encode(envelope));
		expect(() => channel.openResponse(envelope.id, response)).toThrow();
	});

	it('rejects low-order prekeys', async () => {
		await expect(
			createChannel(connectorKey(), vectors.connectorId, new Uint8Array(32))
		).rejects.toThrow();
	});

	it('round-trips through encode and decode', () => {
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: [null, ''] };
		expect(decode(encode(envelope))).toEqual(envelope);
	});
});
