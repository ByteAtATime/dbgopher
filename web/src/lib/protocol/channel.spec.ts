import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from '../../../../protocol/vectors.json';
import { createChannel, decode, deriveKey, encode, open, seal } from './channel';

const connectorKey = () => sodium.from_hex(vectors.connectorKey);
const aad = () => new TextEncoder().encode(vectors.connectorId);

beforeAll(() => sodium.ready);

describe('vectors', () => {
	it('derives the per-direction keys', () => {
		expect(sodium.to_hex(deriveKey(connectorKey(), 'dbgopher/request'))).toBe(vectors.requestKey);
		expect(sodium.to_hex(deriveKey(connectorKey(), 'dbgopher/response'))).toBe(vectors.responseKey);
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
	it('seals requests the connector can open', async () => {
		const channel = await createChannel(connectorKey(), vectors.connectorId);
		const { id, sealed } = channel.sealRequest({ message: 'hello' });
		const requestKey = sodium.from_hex(vectors.requestKey);
		expect(decode(open(requestKey, aad(), sealed))).toMatchObject({
			id,
			body: { message: 'hello' }
		});
	});

	it('opens responses only for the request they answer', async () => {
		const channel = await createChannel(connectorKey(), vectors.connectorId);
		const [, response] = vectors.messages;
		const sealed = sodium.from_hex(response.sealed);
		expect(channel.openResponse(response.envelope.id, sealed)).toEqual(response.envelope.body);
		expect(() => channel.openResponse(crypto.randomUUID(), sealed)).toThrow();
	});

	it('rejects responses sealed for another connector', async () => {
		const channel = await createChannel(connectorKey(), 'another-connector');
		const [, response] = vectors.messages;
		expect(() =>
			channel.openResponse(response.envelope.id, sodium.from_hex(response.sealed))
		).toThrow();
	});

	it('round-trips through encode and decode', () => {
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: [null, ''] };
		expect(decode(encode(envelope))).toEqual(envelope);
	});
});
