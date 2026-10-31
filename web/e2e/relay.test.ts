import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/server/tokens';
import { connector, session, user } from '../src/lib/server/db/schema';
import { createChannel } from '../src/lib/protocol/channel';
import { ConnectorError, createClient, RelayError } from '../src/lib/protocol/client';
import type { Column } from '../src/lib/protocol/bindings/Column';

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

const post = (sealed: Uint8Array, cookie = ownerCookie) =>
	fetch(`http://127.0.0.1:${port}/v1/connectors/${credentials.id}/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream', 'x-session-id': 'e2e', cookie },
		body: new Uint8Array(sealed)
	});

const send = async (body: unknown, key = credentials.key) => {
	const channel = await createChannel(key, credentials.id);
	const { id, sealed } = channel.sealRequest(body);
	const response = await post(sealed);
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
		.values({ userId: owner.userId, tokenHash: hashToken(token) })
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
		const channel = await createChannel(credentials.key, credentials.id);
		expect((await post(channel.sealRequest({ type: 'hello' }).sealed, '')).status).toBe(401);
	});

	it("hides connectors from users who don't own them", async () => {
		await startConnector().waitFor('Connected to relay');
		const channel = await createChannel(credentials.key, credentials.id);
		const response = await post(channel.sealRequest({ type: 'hello' }).sealed, strangerCookie);
		expect(response.status).toBe(404);
	});

	it('reports connectors that are not connected as offline', async () => {
		const { response } = await hello();
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
			capabilities: ['overview'],
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
						column('Payload', 'jsonb', 3802, { nullable: true })
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
		const channel = await createChannel(credentials.key, credentials.id);
		const { id, sealed } = channel.sealRequest({ type: 'teleport' });
		const response = await post(sealed);
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
		const channel = await createChannel(credentials.key, credentials.id);
		const { sealed } = channel.sealRequest({ type: 'hello' });
		expect((await post(sealed)).status).toBe(200);
		const replay = await post(sealed);
		expect(replay.status).toBe(422);
		expect(await replay.json()).toEqual({ rejection: 'REPLAYED' });
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
		const client = await browserClient();
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

	it('reports offline connectors', async () => {
		const client = await browserClient();
		await expect(client.hello()).rejects.toMatchObject({ reason: 'offline' });
	});

	it('reports keys the connector cannot use', async () => {
		await startConnector().waitFor('Connected to relay');
		const error = await (
			await browserClient(randomBytes(32))
		)
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
		const error = await (await browserClient()).overview().catch((error: unknown) => error);
		expect(error).toBeInstanceOf(ConnectorError);
		expect(error).toMatchObject({ message: expect.stringContaining('error connecting to server') });
	});
});
