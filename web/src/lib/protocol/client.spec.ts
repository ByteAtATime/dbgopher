import sodium from 'libsodium-wrappers';
import { beforeAll, describe, expect, it } from 'vitest';
import { decode, deriveKey, encode, open, seal } from './channel';
import { ConnectorError, createClient, RelayError, type Fetch } from './client';

const CONNECTOR_ID = 'c0ffee00-0000-4000-8000-000000000000';
const aad = new TextEncoder().encode(CONNECTOR_ID);
let connectorKey: Uint8Array;

beforeAll(async () => {
	await sodium.ready;
	connectorKey = sodium.randombytes_buf(32);
});

const connector =
	(respond: (request: unknown) => unknown): Fetch =>
	async (_path, init) => {
		const sealed = new Uint8Array(await new Response(init.body).arrayBuffer());
		const request = decode(open(deriveKey(connectorKey, 'dbgopher/request'), aad, sealed));
		const body = respond(request.body);
		const envelope = { id: request.id, sentAt: Date.now(), body };
		return new Response(seal(deriveKey(connectorKey, 'dbgopher/response'), aad, encode(envelope)));
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
	it('posts sealed requests to the connector with a stable session', async () => {
		const calls: [string, RequestInit][] = [];
		const respond = connector(() => hello);
		const api = await client((path, init) => {
			calls.push([path, init]);
			return respond(path, init);
		});
		await api.hello();
		await api.hello();
		expect(calls.map(([path]) => path)).toEqual([
			`/v1/connectors/${CONNECTOR_ID}/rpc`,
			`/v1/connectors/${CONNECTOR_ID}/rpc`
		]);
		const sessions = calls.map(([, init]) => new Headers(init.headers).get('x-session-id'));
		expect(sessions[0]).toBeTruthy();
		expect(sessions[1]).toBe(sessions[0]);
	});

	it('returns the response to a request', async () => {
		let received: unknown;
		const api = await client(
			connector((request) => {
				received = request;
				return hello;
			})
		);
		expect(await api.hello()).toEqual(hello);
		expect(received).toEqual({ type: 'hello' });
	});

	it('ignores capabilities and fields it does not know', async () => {
		const api = await client(
			connector(() => ({ ...hello, capabilities: ['overview', 'teleport'], extra: true }))
		);
		expect(await api.hello()).toEqual(hello);
	});

	it('throws connector errors with their message', async () => {
		const message = 'relation "orders" does not exist';
		const api = await client(connector(() => ({ type: 'error', message })));
		await expect(api.overview()).rejects.toEqual(new ConnectorError(message));
	});

	it('rejects responses it does not understand', async () => {
		const api = await client(connector(() => ({ type: 'overview', tables: [{ name: 1 }] })));
		await expect(api.overview()).rejects.toThrow('does not understand');
	});

	it.each([
		[503, 'offline'],
		[504, 'timeout'],
		[413, 'tooLarge'],
		[500, 'unexpected']
	])('maps status %i to %s', async (status, reason) => {
		const api = await client(async () => new Response(null, { status }));
		await expect(api.hello()).rejects.toMatchObject({ name: 'RelayError', reason });
	});

	it.each([
		['UNDECRYPTABLE', 'undecryptable'],
		['EXPIRED', 'expired'],
		['REPLAYED', 'replayed'],
		['MALFORMED', 'malformed'],
		['UNSPECIFIED', 'rejected']
	])('maps the %s rejection to %s', async (rejection, reason) => {
		const api = await client(async () => Response.json({ rejection }, { status: 422 }));
		await expect(api.hello()).rejects.toMatchObject({ name: 'RelayError', reason });
	});

	it('reports an unreachable relay', async () => {
		const api = await client(async () => {
			throw new TypeError('fetch failed');
		});
		const error = await api.hello().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(RelayError);
		expect(error).toMatchObject({ reason: 'unreachable' });
	});
});
