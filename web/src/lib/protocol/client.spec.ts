import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from '../../../../protocol/vectors.json';
import { decode, deriveKey, deriveSessionKey, encode, open, seal } from './channel';
import { ConnectorError, createClient, RelayError, type Fetch } from './client';

const CONNECTOR_ID = 'c0ffee00-0000-4000-8000-000000000000';
const aad = new TextEncoder().encode(CONNECTOR_ID);
const HANDSHAKE = parseInt(vectors.handshake.frame.slice(0, 2), 16);
let connectorKey: Uint8Array;

beforeAll(async () => {
	await sodium.ready;
	connectorKey = sodium.randombytes_buf(32);
});

const connector = (respond: (request: unknown) => unknown) => {
	const sessions = new Map<string, Uint8Array>();
	const handshakes: string[] = [];
	const fetch: Fetch = async (_path, init) => {
		const sessionId = new Headers(init.headers).get('x-session-id') ?? '';
		const frame = new Uint8Array(await new Response(init.body).arrayBuffer());
		if (frame[0] === HANDSHAKE) {
			const secret = sodium.randombytes_buf(32);
			const connectorPublic = sodium.crypto_scalarmult_base(secret);
			const browserPublic = frame.subarray(1);
			const shared = sodium.crypto_scalarmult(secret, browserPublic);
			handshakes.push(sessionId);
			sessions.set(
				sessionId,
				deriveSessionKey(connectorKey, sessionId, browserPublic, connectorPublic, shared)
			);
			return new Response(new Uint8Array(connectorPublic));
		}
		const sessionKey = sessions.get(sessionId);
		if (!sessionKey) return Response.json({ rejection: 'UNKNOWN_SESSION' }, { status: 422 });
		const request = decode(open(deriveKey(sessionKey, 'dbgopher/request'), aad, frame));
		const envelope = { id: request.id, sentAt: Date.now(), body: respond(request.body) };
		return new Response(seal(deriveKey(sessionKey, 'dbgopher/response'), aad, encode(envelope)));
	};
	return { fetch, sessions, handshakes };
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
	it('posts sealed requests to the connector over one handshaken session', async () => {
		const calls: [string, RequestInit][] = [];
		const { fetch, handshakes } = connector(() => hello);
		const api = client((path, init) => {
			calls.push([path, init]);
			return fetch(path, init);
		});
		await Promise.all([api.hello(), api.hello()]);
		await api.hello();
		expect(calls.map(([path]) => path)).toEqual(
			Array(4).fill(`/v1/connectors/${CONNECTOR_ID}/rpc`)
		);
		const sessions = calls.map(([, init]) => new Headers(init.headers).get('x-session-id'));
		expect(handshakes).toHaveLength(1);
		expect(sessions).toEqual(Array(4).fill(handshakes[0]));
	});

	it('handshakes again when the connector forgets the session', async () => {
		const { fetch, sessions, handshakes } = connector(() => hello);
		const api = client(fetch);
		await api.hello();
		sessions.clear();
		expect(await api.hello()).toEqual(hello);
		expect(handshakes).toHaveLength(2);
		expect(handshakes[1]).not.toBe(handshakes[0]);
	});

	it('handshakes again after a failed handshake', async () => {
		const { fetch, handshakes } = connector(() => hello);
		let offline = true;
		const api = client(async (path, init) =>
			offline ? new Response(null, { status: 503 }) : fetch(path, init)
		);
		await expect(api.hello()).rejects.toMatchObject({ reason: 'offline' });
		offline = false;
		expect(await api.hello()).toEqual(hello);
		expect(handshakes).toHaveLength(1);
	});

	it('gives up when a fresh session is also unknown', async () => {
		const { fetch, sessions } = connector(() => hello);
		const api = client(async (path, init) => {
			const response = await fetch(path, init);
			sessions.clear();
			return response;
		});
		await expect(api.hello()).rejects.toMatchObject({ reason: 'unknownSession' });
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
		['UNKNOWN_SESSION', 'unknownSession'],
		['UNSPECIFIED', 'rejected']
	])('maps the %s rejection to %s', async (rejection, reason) => {
		const api = client(async () => Response.json({ rejection }, { status: 422 }));
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
