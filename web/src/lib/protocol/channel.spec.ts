import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from '../../../../protocol/vectors.json';
import {
	concat,
	decode,
	encode,
	requestHeader,
	sealRequest,
	suite,
	SUITE,
	userKeyFromSeed,
	verifyKeyConfig,
	verifyPairingProof
} from './channel';

const hex = (text: string) => sodium.from_hex(text);
const signedConfig = () => concat(hex(vectors.keyConfig.config), hex(vectors.keyConfig.signature));
const verify = (signed = signedConfig(), overrides = {}) =>
	verifyKeyConfig(signed, {
		identityKey: hex(vectors.identity.public),
		connectorId: vectors.connectorId,
		now: vectors.keyConfig.expiresAt - 1,
		...overrides
	});

beforeAll(() => sodium.ready);

describe('vectors', () => {
	it('uses the vector suite', () => {
		expect(sodium.to_hex(SUITE)).toBe(vectors.suite);
	});

	it('matches the RFC 9180 base mode vectors', async () => {
		const { rfc9180: rfc } = vectors;
		const sender = await suite.createSenderContext({
			recipientPublicKey: await suite.kem.deserializePublicKey(hex(rfc.pkRm)),
			info: hex(rfc.info),
			ekm: hex(rfc.ikmE)
		});
		expect(sodium.to_hex(new Uint8Array(sender.enc))).toBe(rfc.enc);
		expect(sodium.to_hex(new Uint8Array(await sender.seal(hex(rfc.pt), hex(rfc.aad))))).toBe(
			rfc.ct
		);
		for (const { context, length, value } of rfc.exports) {
			expect(sodium.to_hex(new Uint8Array(await sender.export(hex(context), length)))).toBe(value);
		}
	});

	it('verifies the vector key config', async () => {
		const keyConfig = await verify();
		expect(keyConfig).toBeDefined();
		expect(sodium.to_hex(keyConfig?.prekey ?? new Uint8Array())).toBe(
			vectors.keyConfig.prekeyPublic
		);
		expect(keyConfig?.expiresAt).toBe(vectors.keyConfig.expiresAt);
		expect(sodium.to_hex(keyConfig?.hash ?? new Uint8Array())).toBe(vectors.keyConfig.hash);
	});

	it('derives the vector user key', async () => {
		const userKey = await userKeyFromSeed(hex(vectors.user.seed));
		expect(sodium.to_hex(userKey.publicKey)).toBe(vectors.user.public);
	});

	it('seals the vector request frame and opens the vector response', async () => {
		const keyConfig = await verify();
		if (!keyConfig) throw new Error('The vector key config does not verify');
		const userKey = await userKeyFromSeed(hex(vectors.user.seed));
		expect(sodium.to_hex(requestHeader(keyConfig, userKey))).toBe(vectors.request.header);
		const { frame, open } = await sealRequest(
			keyConfig,
			userKey,
			hex(vectors.request.plaintext),
			hex(vectors.request.ikmE)
		);
		expect(sodium.to_hex(frame)).toBe(vectors.request.frame);
		expect(sodium.to_hex(await open(hex(vectors.response.frame)))).toBe(vectors.response.plaintext);
	});

	it('verifies the vector pairing proof', async () => {
		const verifyProof = (proof: Uint8Array) =>
			verifyPairingProof(
				hex(vectors.pairing.secret),
				vectors.connectorId,
				hex(vectors.identity.public),
				proof
			);
		const proof = hex(vectors.pairing.proof);
		expect(await verifyProof(proof)).toBe(true);
		proof[0] ^= 1;
		expect(await verifyProof(proof)).toBe(false);
	});

	it.each(vectors.envelopes)('decodes the envelope $envelope.id', ({ envelope, plaintext }) => {
		expect(decode(hex(plaintext))).toEqual(envelope);
	});
});

describe('verifyKeyConfig', () => {
	it.each([
		[
			'signed by another identity',
			() => verify(signedConfig(), { identityKey: new Uint8Array(32) })
		],
		['for another connector', () => verify(signedConfig(), { connectorId: crypto.randomUUID() })],
		['expired', () => verify(signedConfig(), { now: vectors.keyConfig.expiresAt })],
		['truncated', () => verify(signedConfig().subarray(1))],
		[
			'tampered',
			() => {
				const signed = signedConfig();
				signed[30] ^= 1;
				return verify(signed);
			}
		]
	])('rejects key configs %s', async (_, verifyConfig) => {
		expect(await verifyConfig()).toBeUndefined();
	});
});

describe('sealRequest', () => {
	it('seals each request under a fresh ephemeral key', async () => {
		const keyConfig = await verify();
		if (!keyConfig) throw new Error('The vector key config does not verify');
		const userKey = await userKeyFromSeed(hex(vectors.user.seed));
		const plaintext = encode({ id: crypto.randomUUID(), sentAt: 0, body: null });
		const first = await sealRequest(keyConfig, userKey, plaintext);
		const second = await sealRequest(keyConfig, userKey, plaintext);
		const headerLength = requestHeader(keyConfig, userKey).length;
		expect(first.frame.subarray(0, headerLength)).toEqual(second.frame.subarray(0, headerLength));
		expect(first.frame.subarray(headerLength, headerLength + 32)).not.toEqual(
			second.frame.subarray(headerLength, headerLength + 32)
		);
	});

	it('rejects responses it cannot open', async () => {
		const keyConfig = await verify();
		if (!keyConfig) throw new Error('The vector key config does not verify');
		const userKey = await userKeyFromSeed(hex(vectors.user.seed));
		const { open } = await sealRequest(keyConfig, userKey, hex(vectors.request.plaintext));
		await expect(open(hex(vectors.response.frame))).rejects.toThrow();
	});

	it('round-trips through encode and decode', () => {
		const envelope = { id: crypto.randomUUID(), sentAt: Date.now(), body: [null, ''] };
		expect(decode(encode(envelope))).toEqual(envelope);
	});
});
