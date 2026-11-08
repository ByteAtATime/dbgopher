import sodium from 'libsodium-wrappers';
import { HkdfSha256 } from '@hpke/core';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Envelope } from './bindings/Envelope';
import { concat, decode, encode, suite, SUITE, uuidBytes } from './channel';
import { ConnectorError, createClient, RelayError, type Fetch } from './client';

const CONNECTOR_ID = 'c0ffee00-0000-4000-8000-000000000000';
const RPC = `POST /v1/connectors/${CONNECTOR_ID}/rpc`;
const KEY_CONFIG = `GET /v1/connectors/${CONNECTOR_ID}/key-config`;
const HOUR_MS = 60 * 60_000;
const text = (value: string) => new TextEncoder().encode(value);
const userKey = new Uint8Array(32).fill(7);
let identity: { publicKey: Uint8Array; privateKey: Uint8Array };

beforeAll(async () => {
	await sodium.ready;
	identity = sodium.crypto_sign_keypair();
});

const createPrekey = async (signer = identity, expiresAt = Date.now() + HOUR_MS) => {
	const keyPair = await suite.kem.generateKeyPair();
	const expires = new Uint8Array(8);
	new DataView(expires.buffer).setBigUint64(0, BigInt(expiresAt));
	const config = concat(
		uuidBytes(CONNECTOR_ID),
		SUITE,
		new Uint8Array(await suite.kem.serializePublicKey(keyPair.publicKey)),
		expires
	);
	const signature = sodium.crypto_sign_detached(
		concat(text('dbgopher/key-config'), config),
		signer.privateKey
	);
	return {
		keyPair,
		signed: concat(config, signature),
		hash: sodium.to_hex(new Uint8Array(await crypto.subtle.digest('SHA-256', config)))
	};
};

const sealResponse = async (secret: ArrayBuffer, enc: Uint8Array, envelope: Envelope<unknown>) => {
	const hkdf = new HkdfSha256();
	const nonce = sodium.randombytes_buf(32);
	const prk = await hkdf.extract(concat(enc, nonce), secret);
	const key = new Uint8Array(await hkdf.expand(prk, text('key'), 32));
	const iv = new Uint8Array(await hkdf.expand(prk, text('nonce'), 12));
	return concat(
		nonce,
		sodium.crypto_aead_chacha20poly1305_ietf_encrypt(encode(envelope), null, null, iv, key)
	);
};

const connector = async (
	respond: (request: Envelope<unknown>) => unknown,
	clock: () => number = Date.now
) => {
	const calls: string[] = [];
	const received: Envelope<unknown>[] = [];
	let prekey = await createPrekey();
	const rotate = async () => {
		prekey = await createPrekey();
	};
	const fetch: Fetch = async (path, init) => {
		calls.push(`${init.method} ${path}`);
		if (path.endsWith('/key-config')) return new Response(new Uint8Array(prekey.signed));
		const frame = new Uint8Array(await new Response(init.body).arrayBuffer());
		const header = frame.subarray(0, 70);
		if (sodium.to_hex(header.subarray(6, 38)) !== prekey.hash)
			return Response.json({ rejection: 'STALE_KEY' }, { status: 422 });
		const enc = frame.subarray(70, 102);
		const signed = frame.subarray(0, frame.length - 64);
		if (
			!sodium.crypto_sign_verify_detached(
				frame.subarray(frame.length - 64),
				concat(text('dbgopher/request-sig'), signed),
				header.subarray(38)
			)
		)
			return Response.json({ rejection: 'UNAUTHORIZED' }, { status: 422 });
		const recipient = await suite.createRecipientContext({
			recipientKey: prekey.keyPair,
			enc,
			info: concat(text('dbgopher/request'), Uint8Array.of(0), header)
		});
		const request = decode(new Uint8Array(await recipient.open(frame.subarray(102, -64))));
		received.push(request);
		const secret = await recipient.export(text('dbgopher/response'), 32);
		const envelope = { id: request.id, sentAt: clock(), body: respond(request) };
		return new Response(await sealResponse(secret, enc, envelope));
	};
	return { fetch, calls, received, rotate, keyConfig: () => prekey.signed };
};

const client = (fetch: Fetch, keyConfig?: Uint8Array, now?: () => number) =>
	createClient({
		connectorId: CONNECTOR_ID,
		identityKey: identity.publicKey,
		userKey,
		keyConfig,
		fetch,
		now
	});

const hello = {
	type: 'hello',
	protocolVersion: 1,
	connectorVersion: '0.1.0',
	capabilities: ['overview'],
	readOnly: true
};

describe('createClient', () => {
	it('seals the first request to a seeded key config without fetching it', async () => {
		const { fetch, calls, keyConfig } = await connector(() => hello);
		const api = client(fetch, keyConfig());
		await Promise.all([api.hello(), api.hello()]);
		await api.hello();
		expect(calls).toEqual([RPC, RPC, RPC]);
	});

	it('fetches the key config once when none is seeded', async () => {
		const { fetch, calls } = await connector(() => hello);
		const api = client(fetch);
		await Promise.all([api.hello(), api.hello()]);
		await api.hello();
		expect(calls).toEqual([KEY_CONFIG, RPC, RPC, RPC]);
	});

	it('retries a stale request once under a fresh key config with the same id', async () => {
		const { fetch, calls, received, rotate, keyConfig } = await connector(() => hello);
		const api = client(fetch, keyConfig());
		await api.hello();
		await rotate();
		expect(await api.hello()).toEqual(hello);
		expect(calls).toEqual([RPC, RPC, KEY_CONFIG, RPC]);
		expect(received).toHaveLength(2);
	});

	it('fetches one fresh key config when concurrent requests are all stale', async () => {
		const { fetch, calls, rotate, keyConfig } = await connector(() => hello);
		const api = client(fetch, keyConfig());
		await rotate();
		expect(await Promise.all([api.hello(), api.hello(), api.hello()])).toEqual([
			hello,
			hello,
			hello
		]);
		expect(calls.toSorted()).toEqual([KEY_CONFIG, RPC, RPC, RPC, RPC, RPC, RPC]);
	});

	it('gives up when a fresh key config is also stale', async () => {
		const { fetch, calls, rotate } = await connector(() => hello);
		let stale = Promise.resolve();
		const api = client(async (path, init) => {
			await stale;
			const response = await fetch(path, init);
			if (path.endsWith('/key-config')) stale = rotate();
			return response;
		});
		await expect(api.hello()).rejects.toMatchObject({ reason: 'staleKey' });
		expect(calls).toEqual([KEY_CONFIG, RPC, KEY_CONFIG, RPC]);
	});

	it('fetches the key config again after the connector was offline', async () => {
		const { fetch, calls } = await connector(() => hello);
		let offline = true;
		const api = client(async (path, init) =>
			offline ? new Response(null, { status: 503 }) : fetch(path, init)
		);
		await expect(api.hello()).rejects.toMatchObject({ reason: 'offline' });
		offline = false;
		expect(await api.hello()).toEqual(hello);
		expect(calls).toEqual([KEY_CONFIG, RPC]);
	});

	it.each([
		[
			'signed by another identity',
			async () => (await createPrekey(sodium.crypto_sign_keypair())).signed
		],
		['already expired', async () => (await createPrekey(identity, Date.now() - 1)).signed],
		['truncated', async () => (await createPrekey()).signed.subarray(1)]
	])('refuses key configs %s', async (_, keyConfig) => {
		const calls: string[] = [];
		const signed = await keyConfig();
		const api = client(async (path, init) => {
			calls.push(`${init.method} ${path}`);
			return new Response(new Uint8Array(signed));
		});
		await expect(api.hello()).rejects.toMatchObject({ name: 'RelayError', reason: 'untrusted' });
		expect(calls).toEqual([KEY_CONFIG]);
	});

	it('fetches a fresh key config before the cached one expires', async () => {
		const { fetch, calls, rotate, keyConfig } = await connector(() => hello);
		let now = Date.now();
		const api = client(fetch, keyConfig(), () => now);
		await api.hello();
		now += HOUR_MS / 2;
		await rotate();
		now += HOUR_MS / 2 - 60_000;
		expect(await api.hello()).toEqual(hello);
		expect(calls).toEqual([RPC, KEY_CONFIG, RPC]);
	});

	it('corrects its clock from a sealed refusal and retries with the same id', async () => {
		const skew = 10 * 60_000;
		const connectorClock = () => Date.now() + skew;
		const { fetch, calls, received, keyConfig } = await connector(
			(request) =>
				Math.abs(request.sentAt - connectorClock()) > 60_000 ? { refusal: 'expired' } : hello,
			connectorClock
		);
		const api = client(fetch, keyConfig());
		expect(await api.hello()).toEqual(hello);
		expect(await api.hello()).toEqual(hello);
		expect(calls).toEqual([RPC, RPC, RPC]);
		expect(received[1].id).toBe(received[0].id);
		expect(received[1].sentAt - received[0].sentAt).toBeGreaterThan(skew - 1_000);
	});

	it.each(['expired', 'replayed'])(
		'reports a %s refusal it cannot recover from',
		async (refusal) => {
			const { fetch, keyConfig } = await connector(() => ({ refusal }));
			await expect(client(fetch, keyConfig()).hello()).rejects.toMatchObject({
				name: 'RelayError',
				reason: refusal
			});
		}
	);

	it('returns the response to a request', async () => {
		const { fetch, received } = await connector(() => hello);
		expect(await client(fetch).hello()).toEqual(hello);
		expect(received.map((request) => request.body)).toEqual([{ type: 'hello' }]);
	});

	it('ignores capabilities and fields it does not know', async () => {
		const { fetch } = await connector(() => ({
			...hello,
			capabilities: ['overview', 'teleport'],
			extra: true
		}));
		expect(await client(fetch).hello()).toEqual(hello);
	});

	it('throws connector errors with their message', async () => {
		const message = 'relation "orders" does not exist';
		const { fetch } = await connector(() => ({ type: 'error', message }));
		await expect(client(fetch).overview()).rejects.toEqual(new ConnectorError(message));
	});

	it('rejects responses it does not understand', async () => {
		const { fetch } = await connector(() => ({ type: 'overview', tables: [{ name: 1 }] }));
		await expect(client(fetch).overview()).rejects.toThrow('does not understand');
	});

	it.each([
		[503, 'offline'],
		[504, 'timeout'],
		[413, 'tooLarge'],
		[500, 'unexpected']
	])('maps status %i to %s', async (status, reason) => {
		const api = client(async () => new Response(null, { status }));
		await expect(api.hello()).rejects.toMatchObject({ name: 'RelayError', reason });
	});

	it.each([
		['UNDECRYPTABLE', 'undecryptable'],
		['UNAUTHORIZED', 'unauthorized'],
		['MALFORMED', 'malformed'],
		['STALE_KEY', 'staleKey'],
		['UNSPECIFIED', 'rejected']
	])('maps the %s rejection to %s', async (rejection, reason) => {
		const { keyConfig } = await connector(() => hello);
		const api = client(async () => Response.json({ rejection }, { status: 422 }), keyConfig());
		await expect(api.hello()).rejects.toMatchObject({ name: 'RelayError', reason });
	});

	it('reports an unreachable relay', async () => {
		const api = client(async () => {
			throw new TypeError('fetch failed');
		});
		const error = await api.hello().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(RelayError);
		expect(error).toMatchObject({ reason: 'unreachable' });
	});
});
