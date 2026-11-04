import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/server/tokens';
import { connector, session, user } from '../src/lib/server/db/schema';
import { createChannel, handshakeFrame } from '../src/lib/protocol/channel';
import { ConnectorError, createClient, RelayError } from '../src/lib/protocol/client';
import type { Column } from '../src/lib/protocol/bindings/Column';
import { deriveWrappingKey } from '../src/lib/vault/argon2';
import { createVault, unlockAccountKey } from '../src/lib/vault/crypto';

const DATABASE_URL = process.env.DATABASE_URL;
const TARGET_DATABASE = `dbgopher_e2e_${randomBytes(4).toString('hex')}`;
const FIXTURE = new URL('./fixture.sql', import.meta.url);
const CONNECTOR_BINARY = new URL('../../connector/target/debug/connector', import.meta.url)
	.pathname;
const SERVER = new URL('../server.js', import.meta.url).pathname;
const AUTH_SECRET = randomBytes(32).toString('hex');

type Process = {
	child: ChildProcess;
	output: () => string;
	waitFor: (text: string) => Promise<void>;
};

const children: ChildProcess[] = [];

const start = (command: string, args: string[], env: Record<string, string>): Process => {
	const child = spawn(command, args, { env: { ...process.env, ...env } });
	children.push(child);
	let output = '';
	const listeners = new Set<() => void>();
	const append = (chunk: Buffer) => {
		output += chunk.toString();
		for (const listener of listeners) listener();
	};
	child.stdout?.on('data', append);
	child.stderr?.on('data', append);
	const waitFor = (text: string) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (!output.includes(text)) return;
				listeners.delete(check);
				resolve();
			};
			listeners.add(check);
			check();
		});
	return { child, output: () => output, waitFor };
};

const freePort = async () => {
	const server = createServer().listen(0);
	await once(server, 'listening');
	const address = server.address();
	server.close();
	if (address === null || typeof address === 'string') throw new Error('No port assigned');
	return address.port;
};

const exitCode = async (child: ChildProcess) => child.exitCode ?? (await once(child, 'exit'))[0];

let port: number;
let relay: Process;
let client: postgres.Sql;
let targetUrl: string;
let credentials: { id: string; token: string; key: Uint8Array };
let ownerCookie: string;
let strangerCookie: string;

const signIn = async (db: ReturnType<typeof drizzle>) => {
	const id = randomUUID();
	await db.insert(user).values({ id, name: 'E2E', email: `${id}@example.com` });
	const token = randomBytes(32).toString('base64url');
	await db.insert(session).values({
		id: randomUUID(),
		token,
		userId: id,
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		updatedAt: new Date()
	});
	const signature = createHmac('sha256', AUTH_SECRET).update(token).digest('base64');
	return {
		userId: id,
		cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
	};
};

const startRelay = async () => {
	relay = start('node', [SERVER], {
		PORT: String(port),
		HOST: '127.0.0.1',
		DATABASE_URL: DATABASE_URL ?? '',
		ORIGIN: `http://127.0.0.1:${port}`,
		BETTER_AUTH_SECRET: AUTH_SECRET,
		GOOGLE_CLIENT_ID: 'e2e',
		GOOGLE_CLIENT_SECRET: 'e2e'
	});
	for (;;) {
		const ready = await fetch(`http://127.0.0.1:${port}/`).then(
			() => true,
			() => false
		);
		if (ready) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};

const startConnector = (overrides: Record<string, string> = {}) =>
	start(CONNECTOR_BINARY, [], {
		RELAY_URL: `ws://127.0.0.1:${port}/connector`,
		CONNECTOR_ID: credentials.id,
		CONNECTOR_TOKEN: credentials.token,
		CONNECTOR_KEY: Buffer.from(credentials.key).toString('hex'),
		DATABASE_URL: targetUrl,
		...overrides
	});

const post = (frame: Uint8Array, sessionId: string, cookie = ownerCookie) =>
	fetch(`http://127.0.0.1:${port}/v1/connectors/${credentials.id}/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream', 'x-session-id': sessionId, cookie },
		body: new Uint8Array(frame)
	});

const connect = (key = credentials.key) =>
	createChannel(key, credentials.id, async (sessionId, frame) => {
		const response = await post(frame, sessionId);
		expect(response.status).toBe(200);
		return new Uint8Array(await response.arrayBuffer());
	});

const send = async (body: unknown, key = credentials.key) => {
	const channel = await connect(key);
	const { id, sealed } = channel.sealRequest(body);
	const response = await post(sealed, channel.sessionId);
	return {
		response,
		open: async () => channel.openResponse(id, new Uint8Array(await response.arrayBuffer()))
	};
};

const hello = (key = credentials.key) => send({ type: 'hello' }, key);

const browserClient = (connectorKey = credentials.key) =>
	createClient({
		connectorId: credentials.id,
		connectorKey,
		fetch: (path, init) =>
			fetch(`http://127.0.0.1:${port}${path}`, {
				...init,
				headers: { ...Object.fromEntries(new Headers(init?.headers)), cookie: ownerCookie }
			})
	});

const createTarget = async () => {
	await client.unsafe(`CREATE DATABASE ${TARGET_DATABASE}`);
	const url = new URL(DATABASE_URL ?? '');
	url.pathname = `/${TARGET_DATABASE}`;
	const target = postgres(url.href);
	await target.unsafe(await readFile(FIXTURE, 'utf8'));
	await target`VACUUM readings`;
	await target.end();
	return url.href;
};

const column = (
	name: string,
	typeName: string,
	typeOid: number,
	flags: Partial<Pick<Column, 'nullable' | 'hasDefault'>> = {}
): Column => ({ name, typeOid, typeName, nullable: false, hasDefault: false, ...flags });

beforeAll(async () => {
	if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
	client = postgres(DATABASE_URL);
	targetUrl = await createTarget();
	const db = drizzle(client);
	const owner = await signIn(db);
	ownerCookie = owner.cookie;
	strangerCookie = (await signIn(db)).cookie;
	const token = randomBytes(32).toString('base64url');
	const [row] = await db
		.insert(connector)
		.values({ userId: owner.userId, name: 'e2e', tokenHash: hashToken(token) })
		.returning({ id: connector.id });
	credentials = { id: row.id, token, key: randomBytes(32) };
	port = await freePort();
	await startRelay();
});

afterEach(() => {
	for (const child of children.splice(0)) if (child !== relay.child) child.kill();
	children.push(relay.child);
});

afterAll(async () => {
	for (const child of children) child.kill();
	await client.unsafe(`DROP DATABASE IF EXISTS ${TARGET_DATABASE} WITH (FORCE)`);
	await client.end();
});

describe('relay', () => {
	it('requires a signed-in user', async () => {
		await startConnector().waitFor('Connected to relay');
		const channel = await connect();
		const { sealed } = channel.sealRequest({ type: 'hello' });
		expect((await post(sealed, channel.sessionId, '')).status).toBe(401);
	});

	it("hides connectors from users who don't own them", async () => {
		await startConnector().waitFor('Connected to relay');
		const channel = await connect();
		const { sealed } = channel.sealRequest({ type: 'hello' });
		const response = await post(sealed, channel.sessionId, strangerCookie);
		expect(response.status).toBe(404);
	});

	it('reports connectors that are not connected as offline', async () => {
		const response = await post(new Uint8Array(33), randomUUID());
		expect(response.status).toBe(503);
	});

	it('answers hello end to end', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await hello();
		expect(response.status).toBe(200);
		expect(await open()).toEqual({
			type: 'hello',
			protocolVersion: 1,
			connectorVersion: '0.1.0',
			capabilities: ['overview', 'browse'],
			readOnly: true
		});
	});

	it('describes the tables, columns and keys of the database', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await send({ type: 'overview' });
		expect(response.status).toBe(200);
		expect(await open()).toEqual({
			type: 'overview',
			tables: [
				{
					schema: 'audit',
					name: 'Event Log',
					kind: 'table',
					rowCount: 1,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [
						column('id', 'integer', 23),
						column('Payload', 'jsonb', 3802, { nullable: true }),
						column('Attachment', 'bytea', 17, { nullable: true })
					],
					primaryKey: ['id'],
					foreignKeys: []
				},
				{
					schema: 'public',
					name: 'customer_totals',
					kind: 'materializedView',
					rowCount: 3,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [
						column('customer_id', 'integer', 23, { nullable: true }),
						column('orders', 'bigint', 20, { nullable: true })
					],
					primaryKey: [],
					foreignKeys: []
				},
				{
					schema: 'public',
					name: 'customers',
					kind: 'table',
					rowCount: 3,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [column('id', 'integer', 23, { hasDefault: true }), column('email', 'text', 25)],
					primaryKey: ['id'],
					foreignKeys: []
				},
				{
					schema: 'public',
					name: 'events',
					kind: 'partitionedTable',
					rowCount: 2,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [column('id', 'integer', 23), column('at', 'date', 1082)],
					primaryKey: ['id', 'at'],
					foreignKeys: []
				},
				{
					schema: 'public',
					name: 'order_items',
					kind: 'table',
					rowCount: 5,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [
						column('order_id', 'bigint', 20),
						column('position', 'integer', 23),
						column('quantity', 'numeric(10,2)', 1700)
					],
					primaryKey: ['order_id', 'position'],
					foreignKeys: [
						{
							name: 'order_items_order_id_fkey',
							columns: ['order_id'],
							referencedSchema: 'public',
							referencedTable: 'orders',
							referencedColumns: ['id']
						}
					]
				},
				{
					schema: 'public',
					name: 'orders',
					kind: 'table',
					rowCount: 4,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [
						column('id', 'bigint', 20, { hasDefault: true }),
						column('customer_id', 'integer', 23),
						column('note', 'text', 25, { nullable: true }),
						column('created_at', 'timestamp with time zone', 1184, { hasDefault: true })
					],
					primaryKey: ['id'],
					foreignKeys: [
						{
							name: 'orders_customer_id_fkey',
							columns: ['customer_id'],
							referencedSchema: 'public',
							referencedTable: 'customers',
							referencedColumns: ['id']
						}
					]
				},
				{
					schema: 'public',
					name: 'readings',
					kind: 'table',
					rowCount: 200000,
					rowCountExact: false,
					totalBytes: expect.any(Number),
					columns: [column('id', 'integer', 23), column('payload', 'text', 25)],
					primaryKey: ['id'],
					foreignKeys: []
				},
				{
					schema: 'public',
					name: 'recent_orders',
					kind: 'view',
					rowCount: null,
					rowCountExact: false,
					totalBytes: 0,
					columns: [
						column('id', 'bigint', 20, { nullable: true }),
						column('customer_id', 'integer', 23, { nullable: true })
					],
					primaryKey: [],
					foreignKeys: []
				},
				{
					schema: 'public',
					name: 'shipments',
					kind: 'table',
					rowCount: 2,
					rowCountExact: true,
					totalBytes: expect.any(Number),
					columns: [
						column('id', 'uuid', 2950, { hasDefault: true }),
						column('order_id', 'bigint', 20, { nullable: true }),
						column('position', 'integer', 23, { nullable: true })
					],
					primaryKey: ['id'],
					foreignKeys: [
						{
							name: 'shipments_order_id_position_fkey',
							columns: ['order_id', 'position'],
							referencedSchema: 'public',
							referencedTable: 'order_items',
							referencedColumns: ['order_id', 'position']
						}
					]
				}
			]
		});
	});

	it('browses rows with a default limit', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await send({ type: 'browse', schema: 'public', table: 'readings' });
		expect(response.status).toBe(200);
		const opened = await open();
		expect(opened).toMatchObject({
			type: 'browse',
			columns: [column('id', 'integer', 23), column('payload', 'text', 25)]
		});
		expect(opened).toHaveProperty('rows.length', 500);
	});

	it('browses rows with a limit and offset', async () => {
		await startConnector().waitFor('Connected to relay');
		const { open } = await send({
			type: 'browse',
			schema: 'audit',
			table: 'Event Log',
			limit: 1,
			offset: 0
		});
		const columns = [
			column('id', 'integer', 23),
			column('Payload', 'jsonb', 3802, { nullable: true }),
			column('Attachment', 'bytea', 17, { nullable: true })
		];
		expect(await open()).toEqual({
			type: 'browse',
			columns,
			rows: [['1', '{"type": "signup"}', { bytes: 782 }]]
		});
		const { open: openEmpty } = await send({
			type: 'browse',
			schema: 'audit',
			table: 'Event Log',
			offset: 1
		});
		expect(await openEmpty()).toEqual({ type: 'browse', columns, rows: [] });
	});

	it('browses rows sorted by a column', async () => {
		await startConnector().waitFor('Connected to relay');
		const payload = 'x'.repeat(100);
		const { open } = await send({
			type: 'browse',
			schema: 'public',
			table: 'readings',
			limit: 2,
			offset: 1,
			sort: { column: 'id', direction: 'desc' }
		});
		expect(await open()).toEqual({
			type: 'browse',
			columns: [column('id', 'integer', 23), column('payload', 'text', 25)],
			rows: [
				['199999', payload],
				['199998', payload]
			]
		});
	});

	it('browses rows matching every filter', async () => {
		await startConnector().waitFor('Connected to relay');
		const { open } = await send({
			type: 'browse',
			schema: 'public',
			table: 'order_items',
			filter: [
				{ column: 'order_id', value: '1' },
				{ column: 'position', value: '2' }
			]
		});
		expect(await open()).toMatchObject({ type: 'browse', rows: [['1', '2', '2.50']] });
		const { open: openOrders } = await send({
			type: 'browse',
			schema: 'public',
			table: 'orders',
			sort: { column: 'id', direction: 'desc' },
			filter: [{ column: 'customer_id', value: '1' }]
		});
		const orders = await openOrders();
		expect(orders).toHaveProperty('rows.length', 2);
		expect(orders).toHaveProperty('rows.0.0', '2');
		const { open: openMissing } = await send({
			type: 'browse',
			schema: 'public',
			table: 'orders',
			filter: [{ column: 'missing', value: '1' }]
		});
		expect(await openMissing()).toMatchObject({
			type: 'error',
			message: expect.stringContaining('missing')
		});
	});

	it('reports database errors to the browser', async () => {
		const closed = await freePort();
		await startConnector({
			DATABASE_URL: `postgres://postgres@127.0.0.1:${closed}/postgres`
		}).waitFor('Connected to relay');
		const { response, open } = await send({ type: 'overview' });
		expect(response.status).toBe(200);
		expect(await open()).toEqual({
			type: 'error',
			message: expect.stringContaining('error connecting to server')
		});
	});

	it('returns encrypted errors for unknown requests', async () => {
		await startConnector().waitFor('Connected to relay');
		const channel = await connect();
		const { id, sealed } = channel.sealRequest({ type: 'teleport' });
		const response = await post(sealed, channel.sessionId);
		expect(channel.openResponse(id, new Uint8Array(await response.arrayBuffer()))).toMatchObject({
			type: 'error'
		});
	});

	it('rejects requests sealed with the wrong key', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response } = await hello(randomBytes(32));
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ rejection: 'UNDECRYPTABLE' });
	});

	it('rejects replayed requests', async () => {
		await startConnector().waitFor('Connected to relay');
		const channel = await connect();
		const { sealed } = channel.sealRequest({ type: 'hello' });
		expect((await post(sealed, channel.sessionId)).status).toBe(200);
		const replay = await post(sealed, channel.sessionId);
		expect(replay.status).toBe(422);
		expect(await replay.json()).toEqual({ rejection: 'REPLAYED' });
	});

	it('rejects requests for sessions the connector has not opened', async () => {
		await startConnector().waitFor('Connected to relay');
		const channel = await connect();
		const { sealed } = channel.sealRequest({ type: 'hello' });
		const response = await post(sealed, randomUUID());
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ rejection: 'UNKNOWN_SESSION' });
	});

	it('rejects malformed handshakes', async () => {
		await startConnector().waitFor('Connected to relay');
		const response = await post(handshakeFrame(Uint8Array.of(1, 2, 3)), randomUUID());
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ rejection: 'MALFORMED' });
	});

	it('stops connectors with an invalid token', async () => {
		const connector = startConnector({ CONNECTOR_TOKEN: 'wrong' });
		expect(await exitCode(connector.child)).toBe(1);
		expect(connector.output()).toContain('REASON_UNAUTHORIZED');
	});

	it('stops connectors with an unknown ID', async () => {
		const connector = startConnector({ CONNECTOR_ID: randomUUID() });
		expect(await exitCode(connector.child)).toBe(1);
		expect(connector.output()).toContain('REASON_UNAUTHORIZED');
	});

	it('records when connectors were last seen', async () => {
		const db = drizzle(client);
		const seen = async () => {
			const [row] = await db
				.select({ lastSeenAt: connector.lastSeenAt, connectorVersion: connector.connectorVersion })
				.from(connector)
				.where(eq(connector.id, credentials.id));
			return row;
		};
		const until = async (predicate: (row: Awaited<ReturnType<typeof seen>>) => boolean) => {
			for (;;) {
				const row = await seen();
				if (predicate(row)) return row;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		};
		await db
			.update(connector)
			.set({ lastSeenAt: null, connectorVersion: null })
			.where(eq(connector.id, credentials.id));
		const process = startConnector();
		await process.waitFor('Connected to relay');
		const connected = await until((row) => row.lastSeenAt !== null);
		expect(connected.connectorVersion).toBe('0.1.0');
		process.child.kill();
		const disconnected = await until(
			(row) => (row.lastSeenAt?.getTime() ?? 0) > (connected.lastSeenAt?.getTime() ?? 0)
		);
		expect(disconnected.connectorVersion).toBe('0.1.0');
	});

	it('replaces older connections with the same ID', async () => {
		const first = startConnector();
		await first.waitFor('Connected to relay');
		await startConnector().waitFor('Connected to relay');
		expect(await exitCode(first.child)).toBe(1);
		expect(first.output()).toContain('REASON_REPLACED');
		expect((await hello()).response.status).toBe(200);
	});

	it('reconnects after the relay restarts', async () => {
		const connector = startConnector();
		await connector.waitFor('Connected to relay');
		relay.child.kill();
		await exitCode(relay.child);
		await connector.waitFor('Disconnected from relay');
		await startRelay();
		await new Promise<void>((resolve) => {
			const check = () =>
				connector.output().split('Connected to relay').length > 2
					? resolve()
					: setTimeout(check, 100);
			check();
		});
		expect((await hello()).response.status).toBe(200);
	});
});

describe('browser client', () => {
	it('loads hello and the overview', async () => {
		await startConnector().waitFor('Connected to relay');
		const client = browserClient();
		expect(await client.hello()).toMatchObject({ type: 'hello', readOnly: true });
		const { tables } = await client.overview();
		expect(tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
			'audit.Event Log',
			'public.customer_totals',
			'public.customers',
			'public.events',
			'public.order_items',
			'public.orders',
			'public.readings',
			'public.recent_orders',
			'public.shipments'
		]);
	});

	it('browses rows', async () => {
		await startConnector().waitFor('Connected to relay');
		const client = browserClient();
		const { columns, rows } = await client.browse({
			schema: 'public',
			table: 'orders',
			limit: 2,
			offset: 1
		});
		expect(columns.map((column) => [column.name, column.typeName])).toEqual([
			['id', 'bigint'],
			['customer_id', 'integer'],
			['note', 'text'],
			['created_at', 'timestamp with time zone']
		]);
		const text = (text: unknown) => ({ kind: 'text', text });
		expect(rows).toEqual([
			[text('2'), text('1'), null, text(expect.any(String))],
			[text('3'), text('2'), null, text(expect.any(String))]
		]);
	});

	it('browses binary columns as their length', async () => {
		await startConnector().waitFor('Connected to relay');
		const client = browserClient();
		const { rows } = await client.browse({ schema: 'audit', table: 'Event Log' });
		expect(rows).toEqual([
			[
				{ kind: 'text', text: '1' },
				{ kind: 'text', text: '{"type": "signup"}' },
				{ kind: 'binary', bytes: 782 }
			]
		]);
	});

	it('opens a new session when the connector restarts', async () => {
		const first = startConnector();
		await first.waitFor('Connected to relay');
		const client = browserClient();
		await client.hello();
		first.child.kill();
		await exitCode(first.child);
		await startConnector().waitFor('Connected to relay');
		expect(await client.hello()).toMatchObject({ type: 'hello' });
	});

	it('reports offline connectors', async () => {
		const client = browserClient();
		await expect(client.hello()).rejects.toMatchObject({ reason: 'offline' });
	});

	it('reports keys the connector cannot use', async () => {
		await startConnector().waitFor('Connected to relay');
		const error = await browserClient(randomBytes(32))
			.hello()
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(RelayError);
		expect(error).toMatchObject({ reason: 'undecryptable' });
	});

	it('reports database errors', async () => {
		const closed = await freePort();
		await startConnector({
			DATABASE_URL: `postgres://postgres@127.0.0.1:${closed}/postgres`
		}).waitFor('Connected to relay');
		const error = await browserClient()
			.overview()
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(ConnectorError);
		expect(error).toMatchObject({ message: expect.stringContaining('error connecting to server') });
	});
});

describe('vault', () => {
	const vaultRequest = (cookie: string, init: RequestInit = {}) =>
		fetch(`http://127.0.0.1:${port}/v1/vault`, {
			...init,
			headers: { 'content-type': 'application/json', cookie }
		});

	const put = (cookie: string, body: unknown) =>
		vaultRequest(cookie, { method: 'PUT', body: JSON.stringify(body) });

	it('requires a signed-in user', async () => {
		expect((await vaultRequest('')).status).toBe(401);
		expect((await put('', {})).status).toBe(401);
	});

	it('stores a vault the browser can unlock', async () => {
		const { userId, cookie } = await signIn(drizzle(client));
		expect((await vaultRequest(cookie)).status).toBe(404);

		const { accountKey, record } = await createVault(userId, 'unlock me', deriveWrappingKey);
		const created = await put(cookie, { ...record, revision: 0 });
		expect(created.status).toBe(200);
		expect(await created.json()).toEqual({ revision: 1 });

		const stored = await vaultRequest(cookie);
		expect(stored.status).toBe(200);
		const body = await stored.json();
		expect(body).toEqual({ ...record, revision: 1 });
		expect(await unlockAccountKey(userId, body, 'unlock me', deriveWrappingKey)).toEqual(
			accountKey
		);
	});

	it('rejects stale revisions', async () => {
		const { userId, cookie } = await signIn(drizzle(client));
		const { record } = await createVault(userId, 'unlock me', deriveWrappingKey);
		expect((await put(cookie, { ...record, revision: 0 })).status).toBe(200);
		expect((await put(cookie, { ...record, revision: 0 })).status).toBe(409);
		expect(await (await put(cookie, { ...record, revision: 1 })).json()).toEqual({ revision: 2 });
		expect((await put(cookie, { ...record, revision: 1 })).status).toBe(409);
	});

	it('rejects malformed vaults', async () => {
		const { cookie } = await signIn(drizzle(client));
		expect((await put(cookie, { revision: 0, salt: 'not base64!' })).status).toBe(400);
	});

	it("hides each user's vault from other users", async () => {
		const owner = await signIn(drizzle(client));
		const { record } = await createVault(owner.userId, 'unlock me', deriveWrappingKey);
		expect((await put(owner.cookie, { ...record, revision: 0 })).status).toBe(200);
		expect((await vaultRequest(strangerCookie)).status).toBe(404);
	});
});
