import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import { decode, deriveKey, deriveSessionKey, encode, open, seal } from './channel';
import { ConnectorError, createClient, RelayError, type Fetch } from './client';

const CONNECTOR_ID = 'c0ffee00-0000-4000-8000-000000000000';
const RPC = `POST /v1/connectors/${CONNECTOR_ID}/rpc`;
const PREKEY = `GET /v1/connectors/${CONNECTOR_ID}/prekey`;
const aad = new TextEncoder().encode(CONNECTOR_ID);
let connectorKey: Uint8Array;

beforeAll(async () => {
	await sodium.ready;
	connectorKey = sodium.randombytes_buf(32);
});

const connector = (respond: (request: unknown) => unknown) => {
	const calls: string[] = [];
	let secret = sodium.randombytes_buf(32);
	let prekey = sodium.crypto_scalarmult_base(secret);
	const rotate = () => {
		secret = sodium.randombytes_buf(32);
		prekey = sodium.crypto_scalarmult_base(secret);
	};
	const fetch: Fetch = async (path, init) => {
		calls.push(`${init.method} ${path}`);
		if (path.endsWith('/prekey')) return new Response(new Uint8Array(prekey));
		const frame = new Uint8Array(await new Response(init.body).arrayBuffer());
		if (sodium.to_hex(frame.subarray(1, 33)) !== sodium.to_hex(prekey))
			return Response.json({ rejection: 'STALE_KEY' }, { status: 422 });
		const browserPublic = frame.subarray(33, 65);
		const sessionKey = deriveSessionKey(
			connectorKey,
			browserPublic,
			prekey,
			sodium.crypto_scalarmult(secret, browserPublic)
		);
		const request = decode(
			open(deriveKey(sessionKey, 'dbgopher/request'), aad, frame.subarray(65))
		);
		const envelope = { id: request.id, sentAt: Date.now(), body: respond(request.body) };
		return new Response(seal(deriveKey(sessionKey, 'dbgopher/response'), aad, encode(envelope)));
	};
	return { fetch, calls, rotate };
};

const client = (fetch: Fetch) => createClient({ connectorId: CONNECTOR_ID, connectorKey, fetch });

const hello = {
	type: 'hello',
	protocolVersion: 1,
	connectorVersion: '0.1.0',
	capabilities: ['overview'],
	readOnly: true
};

describe('createClient', () => {
	it('fetches the prekey once when none is seeded', async () => {
		const { fetch, calls } = connector(() => hello);
		const api = client(fetch);
		await Promise.all([api.hello(), api.hello()]);
		await api.hello();
		expect(calls).toEqual([PREKEY, RPC, RPC, RPC]);
	});

	it('fetches a fresh prekey and retries once when the prekey is stale', async () => {
		const { fetch, calls, rotate } = connector(() => hello);
		const api = client(fetch);
		await api.hello();
		rotate();
		expect(await api.hello()).toEqual(hello);
		expect(calls).toEqual([PREKEY, RPC, RPC, PREKEY, RPC]);
	});

	it('gives up when a fresh prekey is also stale', async () => {
		const { fetch, calls, rotate } = connector(() => hello);
		const api = client(async (path, init) => {
			const response = await fetch(path, init);
			if (path.endsWith('/prekey')) rotate();
			return response;
		});
		await expect(api.hello()).rejects.toMatchObject({ reason: 'staleKey' });
		expect(calls).toEqual([PREKEY, RPC, PREKEY, RPC]);
	});

	it('fetches the prekey again after the connector was offline', async () => {
		const { fetch, calls } = connector(() => hello);
		let offline = true;
		const api = client(async (path, init) =>
			offline ? new Response(null, { status: 503 }) : fetch(path, init)
		);
		await expect(api.hello()).rejects.toMatchObject({ reason: 'offline' });
		offline = false;
		expect(await api.hello()).toEqual(hello);
		expect(calls).toEqual([PREKEY, RPC]);
	});

	it('rejects low-order prekeys', async () => {
		const api = client(async () => new Response(new Uint8Array(32)));
		await expect(api.hello()).rejects.toThrow();
	});

	it('returns the response to a request', async () => {
		let received: unknown;
		const api = client(
			connector((request) => {
				received = request;
				return hello;
			}).fetch
		);
		expect(await api.hello()).toEqual(hello);
		expect(received).toEqual({ type: 'hello' });
	});

	it('ignores capabilities and fields it does not know', async () => {
		const api = client(
			connector(() => ({ ...hello, capabilities: ['overview', 'teleport'], extra: true })).fetch
		);
		expect(await api.hello()).toEqual(hello);
	});

	it('throws connector errors with their message', async () => {
		const message = 'relation "orders" does not exist';
		const api = client(connector(() => ({ type: 'error', message })).fetch);
		await expect(api.overview()).rejects.toEqual(new ConnectorError(message));
	});

	it('rejects responses it does not understand', async () => {
		const api = client(connector(() => ({ type: 'overview', tables: [{ name: 1 }] })).fetch);
		await expect(api.overview()).rejects.toThrow('does not understand');
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
		['EXPIRED', 'expired'],
		['REPLAYED', 'replayed'],
		['MALFORMED', 'malformed'],
		['STALE_KEY', 'staleKey'],
		['UNSPECIFIED', 'rejected']
	])('maps the %s rejection to %s', async (rejection, reason) => {
		const prekey = sodium.crypto_scalarmult_base(sodium.randombytes_buf(32));
		const api = client(async (path) =>
			path.endsWith('/prekey')
				? new Response(new Uint8Array(prekey))
				: Response.json({ rejection }, { status: 422 })
		);
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
