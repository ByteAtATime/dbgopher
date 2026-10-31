import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lib/server/connectors';
import { connector } from '../src/lib/server/db/schema';
import { createChannel } from '../src/lib/protocol/channel';

const DATABASE_URL = process.env.DATABASE_URL;
const CONNECTOR_BINARY = new URL('../../connector/target/debug/connector', import.meta.url)
	.pathname;
const SERVER = new URL('../server.js', import.meta.url).pathname;

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
let credentials: { id: string; token: string; key: Uint8Array };

const startRelay = async () => {
	relay = start('node', [SERVER], {
		PORT: String(port),
		HOST: '127.0.0.1',
		DATABASE_URL: DATABASE_URL ?? ''
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
		...overrides
	});

const post = (sealed: Uint8Array, id = credentials.id) =>
	fetch(`http://127.0.0.1:${port}/v1/connectors/${id}/rpc`, {
		method: 'POST',
		headers: { 'content-type': 'application/octet-stream', 'x-session-id': 'e2e' },
		body: new Uint8Array(sealed)
	});

const hello = async (key = credentials.key) => {
	const channel = await createChannel(key, credentials.id);
	const { id, sealed } = channel.sealRequest({ type: 'hello' });
	const response = await post(sealed);
	return {
		response,
		open: async () => channel.openResponse(id, new Uint8Array(await response.arrayBuffer()))
	};
};

beforeAll(async () => {
	if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
	client = postgres(DATABASE_URL);
	const token = randomBytes(32).toString('base64url');
	const [row] = await drizzle(client)
		.insert(connector)
		.values({ tokenHash: hashToken(token) })
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
	await client.end();
});

describe('relay', () => {
	it('reports connectors that are not connected as offline', async () => {
		const { response } = await hello();
		expect(response.status).toBe(503);
	});

	it('answers hello end to end', async () => {
		await startConnector().waitFor('Connected to relay');
		const { response, open } = await hello();
		expect(response.status).toBe(200);
		expect(await open()).toEqual({ type: 'hello', protocolVersion: 1, connectorVersion: '0.1.0' });
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
