import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from '../../../../protocol/vectors.json';
import {
	createChannel,
	decode,
	deriveKey,
	deriveSessionKey,
	encode,
	handshakeFrame,
	open,
	seal,
	type Exchange
} from './channel';

const { handshake } = vectors;
const connectorKey = () => sodium.from_hex(vectors.connectorKey);
const aad = () => new TextEncoder().encode(vectors.connectorId);

beforeAll(() => sodium.ready);

const connector = () => {
	const exchanges: { sessionId: string; frame: Uint8Array }[] = [];
	const exchange: Exchange = async (sessionId, frame) => {
		exchanges.push({ sessionId, frame });
		return sodium.from_hex(handshake.connectorPublic);
	};
	const keys = () => {
		const [{ sessionId, frame }] = exchanges;
		const browserPublic = frame.subarray(1);
		const sessionKey = deriveSessionKey(
			connectorKey(),
			sessionId,
			browserPublic,
			sodium.from_hex(handshake.connectorPublic),
			sodium.crypto_scalarmult(sodium.from_hex(handshake.connectorSecret), browserPublic)
		);
		return {
			request: deriveKey(sessionKey, 'dbgopher/request'),
			response: deriveKey(sessionKey, 'dbgopher/response')
		};
	};
	return { exchange, exchanges, keys };
};

describe('vectors', () => {
	it('derives the session key from the handshake', () => {
		const browserSecret = sodium.from_hex(handshake.browserSecret);
		const connectorPublic = sodium.from_hex(handshake.connectorPublic);
		expect(sodium.to_hex(sodium.crypto_scalarmult_base(browserSecret))).toBe(
			handshake.browserPublic
		);
		const shared = sodium.crypto_scalarmult(browserSecret, connectorPublic);
		expect(sodium.to_hex(shared)).toBe(handshake.shared);
		const sessionKey = deriveSessionKey(
			connectorKey(),
			handshake.sessionId,
			sodium.from_hex(handshake.browserPublic),
			connectorPublic,
			shared
		);
		expect(sodium.to_hex(sessionKey)).toBe(handshake.sessionKey);
	});

	it('encodes the handshake frame', () => {
		expect(sodium.to_hex(handshakeFrame(sodium.from_hex(handshake.browserPublic)))).toBe(
			handshake.frame
		);
	});

	it('derives the per-direction keys', () => {
		const sessionKey = sodium.from_hex(handshake.sessionKey);
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
	it('opens a fresh session with an ephemeral key', async () => {
		const first = connector();
		const second = connector();
		const channel = await createChannel(connectorKey(), vectors.connectorId, first.exchange);
		await createChannel(connectorKey(), vectors.connectorId, second.exchange);
		const [{ sessionId, frame }] = first.exchanges;
		expect(channel.sessionId).toBe(sessionId);
		expect(sodium.to_hex(frame)).toBe(sodium.to_hex(handshakeFrame(frame.subarray(1))));
		expect(second.exchanges[0].sessionId).not.toBe(sessionId);
		expect(second.exchanges[0].frame).not.toEqual(frame);
	});

	it('seals requests the connector can open', async () => {
		const { exchange, keys } = connector();
		const channel = await createChannel(connectorKey(), vectors.connectorId, exchange);
		const { id, sealed } = channel.sealRequest({ message: 'hello' });
		expect(decode(open(keys().request, aad(), sealed))).toMatchObject({
			id,
			body: { message: 'hello' }
		});
	});

	it('opens responses only for the request they answer', async () => {
		const { exchange, keys } = connector();
		const channel = await createChannel(connectorKey(), vectors.connectorId, exchange);
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: 'pong' };
		const sealed = seal(keys().response, aad(), encode(envelope));
		expect(channel.openResponse(envelope.id, sealed)).toBe('pong');
		expect(() => channel.openResponse(crypto.randomUUID(), sealed)).toThrow();
	});

	it('rejects responses sealed for another connector', async () => {
		const { exchange, keys } = connector();
		const channel = await createChannel(connectorKey(), 'another-connector', exchange);
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: 'pong' };
		const sealed = seal(keys().response, aad(), encode(envelope));
		expect(() => channel.openResponse(envelope.id, sealed)).toThrow();
	});

	it('rejects low-order connector keys', async () => {
		await expect(
			createChannel(connectorKey(), vectors.connectorId, async () => new Uint8Array(32))
		).rejects.toThrow();
	});

	it('round-trips through encode and decode', () => {
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: [null, ''] };
		expect(decode(encode(envelope))).toEqual(envelope);
	});
});
