import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import sodium from 'libsodium-wrappers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/server/tokens';
import { connector, session, user } from '../src/lib/server/db/schema';
import {
	concat,
	decode,
	encode,
	sealRequest,
	userKeyFromSeed,
	verifyKeyConfig,
	type KeyConfig,
	type UserKey
} from '../src/lib/protocol/channel';
import { ConnectorError, createClient, RelayError } from '../src/lib/protocol/client';
import type { Column } from '../src/lib/protocol/bindings/Column';
import type { Index } from '../src/lib/protocol/bindings/Index';
import type { IndexKey } from '../src/lib/protocol/bindings/IndexKey';
import { deriveWrappingKey } from '../src/lib/vault/argon2';
import { createVault, unlockAccountKey } from '../src/lib/vault/crypto';

const DATABASE_URL = process.env.DATABASE_URL;
const TARGET_DATABASE = `dbgopher_e2e_${randomBytes(4).toString('hex')}`;
const FIXTURE = new URL('./fixture.sql', import.meta.url);
const CONNECTOR_BINARY = new URL('../../connector/target/debug/connector', import.meta.url)
	.pathname;
const SERVER = new URL('../server.js', import.meta.url).pathname;
const AUTH_SECRET = randomBytes(32).toString('hex');
const HOUR_MS = 60 * 60_000;

type Process = {
	child: ChildProcess;
	output: () => string;
	waitFor: (text: string) => Promise<void>;
};

type Pairing = { id: string; enrollmentToken: string; pairingSecret: Uint8Array };

const children: ChildProcess[] = [];
const stateDirs: string[] = [];

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

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const text = (value: string) => new TextEncoder().encode(value);

let port: number;
let relay: Process;
let client: postgres.Sql;
let targetUrl: string;
let ownerId: string;
let credentials: Pairing & { stateDir: string };
let identityKey: Uint8Array;
let userSeed: Uint8Array;
let userKey: UserKey;
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
		expiresAt: new Date(Date.now() + HOUR_MS),
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

const createPairing = async (enrollmentExpiresAt = new Date(Date.now() + HOUR_MS)) => {
	const enrollmentToken = randomBytes(32).toString('base64url');
	const [row] = await drizzle(client)
		.insert(connector)
		.values({
			userId: ownerId,
			name: 'e2e',
			enrollmentTokenHash: hashToken(enrollmentToken),
			enrollmentExpiresAt
		})
		.returning({ id: connector.id });
	return { id: row.id, enrollmentToken, pairingSecret: randomBytes(32) };
};

const pairingCode = ({ enrollmentToken, pairingSecret }: Pairing) =>
	`${enrollmentToken}.${hex(pairingSecret)}`;

const createStateDir = async () => {
	const dir = await mkdtemp(join(tmpdir(), 'dbgopher-e2e-'));
	stateDirs.push(dir);
	return join(dir, 'state');
};

const startConnector = (overrides: Record<string, string> = {}) =>
	start(CONNECTOR_BINARY, [], {
		RELAY_URL: `ws://127.0.0.1:${port}/connector`,
		CONNECTOR_ID: credentials.id,
		CONNECTOR_STATE_DIR: credentials.stateDir,
		DATABASE_URL: targetUrl,
		...overrides
	});

const stopsWith = async (connector: Process, message: string) => {
	expect(await exitCode(connector.child)).toBe(1);
	expect(connector.output()).toContain(message);
};

const readIdentityKey = async (stateDir: string) => {
	const seed = Buffer.from((await readFile(join(stateDir, 'identity'), 'utf8')).trim(), 'hex');
	return sodium.crypto_sign_seed_keypair(seed).publicKey;
};

const connectorPath = (path: string, id = credentials.id) =>
	`http://127.0.0.1:${port}/v1/connectors/${id}/${path}`;

const post = (frame: Uint8Array, cookie = ownerCookie) =>
	fetch(connectorPath('rpc'), {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream', cookie },
		body: new Uint8Array(frame)
	});

const getKeyConfig = (cookie = ownerCookie) =>
	fetch(connectorPath('key-config'), { headers: { cookie } });

const getEnrollment = (cookie = ownerCookie, id = credentials.id) =>
	fetch(connectorPath('enrollment', id), { headers: { cookie } });

const fetchKeyConfig = async () => {
	const response = await getKeyConfig();
	expect(response.status).toBe(200);
	const keyConfig = await verifyKeyConfig(new Uint8Array(await response.arrayBuffer()), {
		identityKey,
		connectorId: credentials.id,
		now: Date.now()
	});
	if (!keyConfig) throw new Error('The relay served a key config the connector did not sign');
	return keyConfig;
};

type SealOptions = { user?: UserKey; sentAt?: number; keyConfig?: KeyConfig };

const seal = async (body: unknown, { user = userKey, sentAt, keyConfig }: SealOptions = {}) => {
	const sealed = await sealRequest(
		keyConfig ?? (await fetchKeyConfig()),
		user,
		encode({ id: randomUUID(), sentAt: sentAt ?? Date.now(), body })
	);
	return {
		frame: sealed.frame,
		open: async (response: Response) =>
			decode(await sealed.open(new Uint8Array(await response.arrayBuffer())))
	};
};

const send = async (body: unknown, options?: SealOptions) => {
	const { frame, open } = await seal(body, options);
	const response = await post(frame);
	return { response, open: async () => (await open(response)).body };
};

const hello = (options?: SealOptions) => send({ type: 'hello' }, options);

const resign = (signed: Uint8Array, user = userKey) =>
	concat(
		signed,
		sodium.crypto_sign_detached(concat(text('dbgopher/request-sig'), signed), user.privateKey)
	);

const expectRejection = async (response: Response, rejection: string) => {
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ rejection });
};

const browserClient = ({ seed = userSeed, identity = identityKey } = {}) =>
	createClient({
		connectorId: credentials.id,
		identityKey: identity,
		userKey: seed,
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

const keyColumn = (name: string, operatorClass: string): IndexKey => ({
	kind: 'column',
	name,
	operatorClass
});

const index = (
	name: string,
	keys: IndexKey[],
	flags: Partial<Pick<Index, 'method' | 'unique' | 'partial'>> = {}
): Index => ({ name, method: 'btree', unique: false, partial: false, keys, ...flags });

const primaryKey = (table: string, keys: IndexKey[]) =>
	index(`${table}_pkey`, keys, { unique: true });

beforeAll(async () => {
	if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
	client = postgres(DATABASE_URL);
	targetUrl = await createTarget();
	const db = drizzle(client);
	const owner = await signIn(db);
	ownerId = owner.userId;
	ownerCookie = owner.cookie;
	strangerCookie = (await signIn(db)).cookie;
	await sodium.ready;
	userSeed = randomBytes(32);
	userKey = await userKeyFromSeed(userSeed);
	port = await freePort();
	await startRelay();
	credentials = { ...(await createPairing()), stateDir: await createStateDir() };
	const paired = startConnector({
		PAIRING_CODE: pairingCode(credentials),
		USER_KEY: hex(userKey.publicKey)
	});
	await paired.waitFor('Connected to relay');
	paired.child.kill();
	await exitCode(paired.child);
	identityKey = await readIdentityKey(credentials.stateDir);
});

afterEach(() => {
	for (const child of children.splice(0)) if (child !== relay.child) child.kill();
	children.push(relay.child);
});

afterAll(async () => {
	for (const child of children) child.kill();
	await Promise.all(stateDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	await client.unsafe(`DROP DATABASE IF EXISTS ${TARGET_DATABASE} WITH (FORCE)`);
	await client.end();
});

describe('pairing', () => {
	it('publishes the identity key with a proof of the pairing secret', async () => {
		const response = await getEnrollment();
		expect(response.status).toBe(200);
		const proof = createHmac('sha256', credentials.pairingSecret)
			.update(text('dbgopher/pair'))
			.update(Buffer.from(credentials.id.replaceAll('-', ''), 'hex'))
			.update(identityKey)
			.digest('hex');
		expect(await response.json()).toEqual({
			enrolled: true,
			identityKey: hex(identityKey),
			proof
		});
	});

	it('keeps the identity key, token and allowlist private to the connector', async () => {
		const mode = async (name: string) =>
			(await stat(join(credentials.stateDir, name))).mode & 0o777;
		expect(await mode('.')).toBe(0o700);
		expect(await mode('identity')).toBe(0o600);
		expect(await mode('token')).toBe(0o600);
		expect(await mode('allowlist')).toBe(0o600);
		expect(await readFile(join(credentials.stateDir, 'allowlist'), 'utf8')).toContain(
			hex(userKey.publicKey)
		);
	});

	it('reports connectors that have not paired yet', async () => {
		const { id } = await createPairing();
		const response = await getEnrollment(ownerCookie, id);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ enrolled: false });
	});

	it.each([
		[
			'a wrong enrollment token',
			async () => ({
				...(await createPairing()),
				enrollmentToken: randomBytes(32).toString('base64url')
			})
		],
		['an expired enrollment token', () => createPairing(new Date(Date.now() - 1))],
		['an enrollment token the connector already used', async () => credentials]
	])('refuses to pair with %s', async (_, pairing) => {
		const target = await pairing();
		const stateDir = await createStateDir();
		await stopsWith(
			startConnector({
				CONNECTOR_ID: target.id,
				CONNECTOR_STATE_DIR: stateDir,
				PAIRING_CODE: pairingCode(target),
				USER_KEY: hex(userKey.publicKey)
			}),
			'REASON_UNAUTHORIZED'
		);
		expect(await (await getEnrollment(ownerCookie, target.id)).json()).not.toMatchObject({
			identityKey: hex(await readIdentityKey(stateDir))
		});
	});

	it('refuses to start unpaired without a pairing code', async () => {
		await stopsWith(
			startConnector({
				CONNECTOR_STATE_DIR: await createStateDir(),
				USER_KEY: hex(userKey.publicKey)
			}),
			'PAIRING_CODE is not set'
		);
	});

	it('refuses to start without a user key', async () => {
		await stopsWith(
			startConnector({
				CONNECTOR_STATE_DIR: await createStateDir(),
				PAIRING_CODE: pairingCode(await createPairing())
			}),
			'lists no user keys'
		);
	});
});

describe('relay', () => {
	it('requires a signed-in user', async () => {
		await startConnector().waitFor('Connected to relay');
		const { frame } = await seal({ type: 'hello' });
		expect((await post(frame, '')).status).toBe(401);
		expect((await getKeyConfig('')).status).toBe(401);
		expect((await getEnrollment('')).status).toBe(401);
	});

	it("hides connectors from users who don't own them", async () => {
		await startConnector().waitFor('Connected to relay');
		const { frame } = await seal({ type: 'hello' });
		expect((await post(frame, strangerCookie)).status).toBe(404);
		expect((await getKeyConfig(strangerCookie)).status).toBe(404);
		expect((await getEnrollment(strangerCookie)).status).toBe(404);
	});

	it('reports connectors that are not connected as offline', async () => {
		expect((await post(new Uint8Array(171))).status).toBe(503);
		expect((await getKeyConfig()).status).toBe(503);
	});

	it('answers hello end to end under a key config the connector signed', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await hello();
		expect(response.status).toBe(200);
		expect(await open()).toEqual({
			type: 'hello',
			protocolVersion: 1,
			connectorVersion: '0.1.0',
			capabilities: ['overview', 'browse', 'palette'],
			readOnly: true
		});
	});

	it('describes the tables, columns and keys of the database', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await send({ type: 'overview' });
		expect(response.status).toBe(200);
		expect(await open()).toEqual({
			type: 'overview',
			searchPath: ['public'],
			fingerprint: expect.stringMatching(/^[0-9a-f]{32}$/),
			unreadableTables: [],
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
					foreignKeys: [],
					indexes: [
						primaryKey('Event Log', [keyColumn('id', 'int4_ops')]),
						index('event_log_payload', [keyColumn('Payload', 'jsonb_path_ops')], { method: 'gin' })
					]
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
					foreignKeys: [],
					indexes: []
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
					foreignKeys: [],
					indexes: [
						index(
							'customers_email_lower',
							[
								{
									kind: 'expression',
									definition: 'lower(email)',
									typeOid: 25,
									typeName: 'text',
									operatorClass: 'text_ops'
								}
							],
							{ unique: true }
						),
						primaryKey('customers', [keyColumn('id', 'int4_ops')])
					]
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
					foreignKeys: [],
					indexes: [
						primaryKey('events', [keyColumn('id', 'int4_ops'), keyColumn('at', 'date_ops')])
					]
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
					],
					indexes: [
						primaryKey('order_items', [
							keyColumn('order_id', 'int8_ops'),
							keyColumn('position', 'int4_ops')
						])
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
					],
					indexes: [
						primaryKey('orders', [keyColumn('id', 'int8_ops')]),
						index(
							'orders_unnoted',
							[keyColumn('customer_id', 'int4_ops'), keyColumn('created_at', 'timestamptz_ops')],
							{ partial: true }
						)
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
					foreignKeys: [],
					indexes: [primaryKey('readings', [keyColumn('id', 'int4_ops')])]
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
					foreignKeys: [],
					indexes: []
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
					],
					indexes: [primaryKey('shipments', [keyColumn('id', 'uuid_ops')])]
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

	it('searches every palette target and reports each outcome', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await send({
			type: 'palette',
			targets: [
				{ schema: 'public', table: 'missing', column: 'id', value: '1' },
				{
					schema: 'public',
					table: 'customers',
					column: 'email',
					comparison: 'lowerEqual',
					value: 'Grace@Example.com'
				},
				{ schema: 'public', table: 'customers', column: 'email', value: 'Grace@Example.com' },
				{ schema: 'public', table: 'orders', column: 'customer_id', value: '1' },
				{ schema: 'public', table: 'orders', column: 'customer_id', value: 'one' }
			]
		});
		expect(response.status).toBe(200);
		expect(await open()).toEqual({
			type: 'palette',
			outcomes: [
				{ kind: 'failed', message: expect.stringContaining('missing') },
				{
					kind: 'rows',
					columns: [column('id', 'integer', 23, { hasDefault: true }), column('email', 'text', 25)],
					rows: [['3', 'grace@example.com']]
				},
				{ kind: 'rows', columns: expect.any(Array), rows: [] },
				{
					kind: 'rows',
					columns: expect.any(Array),
					rows: [
						['1', '1', null, expect.any(String)],
						['2', '1', null, expect.any(String)]
					]
				},
				{ kind: 'failed', message: expect.stringContaining('integer') }
			]
		});
	});

	it('reports palette targets denied to the database user', async () => {
		const role = `palette_${randomBytes(4).toString('hex')}`;
		const target = postgres(targetUrl);
		await target.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${role}'`);
		try {
			await target.unsafe(`GRANT SELECT (id) ON customers TO ${role}`);
			await target.unsafe(`GRANT SELECT ON orders TO ${role}`);
			const url = new URL(targetUrl);
			url.username = role;
			url.password = role;
			const connector = startConnector({ DATABASE_URL: url.href });
			await connector.waitFor('Connected to relay');
			const { open } = await send({
				type: 'palette',
				targets: [
					{ schema: 'public', table: 'customers', column: 'id', value: '1' },
					{ schema: 'public', table: 'orders', column: 'id', value: '1' }
				]
			});
			expect(await open()).toMatchObject({
				type: 'palette',
				outcomes: [
					{ kind: 'denied' },
					{ kind: 'rows', rows: [['1', '1', null, expect.any(String)]] }
				]
			});
			connector.child.kill();
			await exitCode(connector.child);
		} finally {
			await target.unsafe(`DROP OWNED BY ${role}`);
			await target.unsafe(`DROP ROLE ${role}`);
			await target.end();
		}
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
		const { response, open } = await send({ type: 'teleport' });
		expect(response.status).toBe(200);
		expect(await open()).toMatchObject({ type: 'error' });
	});

	it('rejects users the connector does not allow', async () => {
		await startConnector().waitFor('Connected to relay');
		const stranger = await userKeyFromSeed(randomBytes(32));
		await expectRejection((await hello({ user: stranger })).response, 'UNAUTHORIZED');
	});

	it('allows user keys added with USER_KEY', async () => {
		const added = await userKeyFromSeed(randomBytes(32));
		await startConnector({ USER_KEY: hex(added.publicKey) }).waitFor('Connected to relay');
		const { response, open } = await hello({ user: added });
		expect(response.status).toBe(200);
		expect(await open()).toMatchObject({ type: 'hello' });
		expect((await hello()).response.status).toBe(200);
	});

	it('rejects requests with a forged signature', async () => {
		await startConnector().waitFor('Connected to relay');
		const { frame } = await seal({ type: 'hello' });
		frame[frame.length - 1] ^= 1;
		await expectRejection(await post(frame), 'UNAUTHORIZED');
	});

	it('rejects signed requests the connector cannot decrypt', async () => {
		await startConnector().waitFor('Connected to relay');
		const { frame } = await seal({ type: 'hello' });
		const signed = frame.slice(0, -64);
		signed[signed.length - 1] ^= 1;
		await expectRejection(await post(resign(signed)), 'UNDECRYPTABLE');
	});

	it('refuses replayed requests with a sealed refusal', async () => {
		await startConnector().waitFor('Connected to relay');
		const { frame, open } = await seal({ type: 'hello' });
		expect((await post(frame)).status).toBe(200);
		const replay = await post(frame);
		expect(replay.status).toBe(200);
		expect((await open(replay)).body).toEqual({ refusal: 'replayed' });
	});

	it('refuses expired requests with a sealed refusal that carries its clock', async () => {
		await startConnector().waitFor('Connected to relay');
		const { frame, open } = await seal({ type: 'hello' }, { sentAt: Date.now() - 10 * 60_000 });
		const response = await post(frame);
		expect(response.status).toBe(200);
		const refusal = await open(response);
		expect(refusal.body).toEqual({ refusal: 'expired' });
		expect(Math.abs(refusal.sentAt - Date.now())).toBeLessThan(5_000);
	});

	it('rejects requests sealed to a key config the connector does not hold', async () => {
		await startConnector().waitFor('Connected to relay');
		const keyConfig = {
			prekey: sodium.crypto_scalarmult_base(sodium.randombytes_buf(32)),
			expiresAt: Date.now() + HOUR_MS,
			hash: randomBytes(32)
		};
		await expectRejection((await hello({ keyConfig })).response, 'STALE_KEY');
	});

	it.each([
		['truncated', async () => Uint8Array.of(4, 1, 2, 3)],
		[
			'from another protocol version',
			async () => {
				const { frame } = await seal({ type: 'hello' });
				frame[0] = 3;
				return frame;
			}
		]
	])('rejects request frames that are %s', async (_, frame) => {
		await startConnector().waitFor('Connected to relay');
		await expectRejection(await post(await frame()), 'MALFORMED');
	});

	it('stops connectors with an invalid token', async () => {
		const stateDir = await createStateDir();
		await mkdir(stateDir);
		await writeFile(join(stateDir, 'token'), 'wrong\n');
		await stopsWith(
			startConnector({ CONNECTOR_STATE_DIR: stateDir, USER_KEY: hex(userKey.publicKey) }),
			'REASON_UNAUTHORIZED'
		);
	});

	it('stops connectors with an unknown ID', async () => {
		await stopsWith(startConnector({ CONNECTOR_ID: randomUUID() }), 'REASON_UNAUTHORIZED');
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

	it('fetches a fresh key config when the connector restarts', async () => {
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

	it('reports user keys the connector does not allow', async () => {
		await startConnector().waitFor('Connected to relay');
		const error = await browserClient({ seed: randomBytes(32) })
			.hello()
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(RelayError);
		expect(error).toMatchObject({ reason: 'unauthorized' });
	});

	it('refuses key configs the connector did not sign', async () => {
		await startConnector().waitFor('Connected to relay');
		const error = await browserClient({ identity: sodium.crypto_sign_keypair().publicKey })
			.hello()
			.catch((error: unknown) => error);
		expect(error).toBeInstanceOf(RelayError);
		expect(error).toMatchObject({ reason: 'untrusted' });
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
