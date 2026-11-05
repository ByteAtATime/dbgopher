import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { markConnectorSeen, verifyConnector } from '../connectors';
import {
	Close_Reason,
	CloseSchema,
	ConnectorMessageSchema,
	Rejection_Reason,
	RelayMessageSchema,
	RequestSchema,
	WelcomeSchema,
	type RelayMessage,
	type Response
} from './relay_pb';

const CONNECTOR_PATH = '/connector';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([1]);
const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const SEEN_INTERVAL_MS = 5 * 60_000;
const MAX_FRAME_SIZE = 1024 * 1024;
export const MAX_SEALED_SIZE = MAX_FRAME_SIZE - 1024;

export type RpcResult =
	| { status: 'ok'; sealed: Uint8Array }
	| { status: 'rejected'; reason: Rejection_Reason }
	| { status: 'offline' }
	| { status: 'timeout' };

type Connection = {
	socket: WebSocket;
	pending: Map<bigint, (result: RpcResult) => void>;
	prekey?: Uint8Array;
};

const decode = (data: RawData) => {
	try {
		return fromBinary(
			ConnectorMessageSchema,
			Array.isArray(data) ? Buffer.concat(data) : new Uint8Array(data)
		).message;
	} catch {
		return undefined;
	}
};

const toRpcResult = (result: Response['result']): RpcResult =>
	result.case === 'sealed'
		? { status: 'ok', sealed: result.value }
		: { status: 'rejected', reason: result.value?.reason ?? Rejection_Reason.UNSPECIFIED };

const send = (socket: WebSocket, message: RelayMessage['message']) =>
	socket.send(toBinary(RelayMessageSchema, create(RelayMessageSchema, { message })));

const close = (socket: WebSocket, reason: Close_Reason, detail: string) => {
	send(socket, { case: 'close', value: create(CloseSchema, { reason, detail }) });
	socket.close();
};

const createRelay = () => {
	const server = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_SIZE });
	const connections = new Map<string, Connection>();
	let nextRequestId = 0n;

	const markSeen = (connectorId: string, connectorVersion?: string) =>
		markConnectorSeen(connectorId, connectorVersion).catch(console.error);

	const register = (connectorId: string, connectorVersion: string, socket: WebSocket) => {
		const previous = connections.get(connectorId);
		if (previous) {
			close(previous.socket, Close_Reason.REPLACED, 'Another connector connected with this ID.');
		}
		const connection: Connection = { socket, pending: new Map() };
		connections.set(connectorId, connection);
		send(socket, { case: 'welcome', value: create(WelcomeSchema) });
		markSeen(connectorId, connectorVersion);
		const seen = setInterval(() => markSeen(connectorId), SEEN_INTERVAL_MS);

		let alive = true;
		const pinger = setInterval(() => {
			if (!alive) return socket.terminate();
			alive = false;
			socket.ping();
		}, PING_INTERVAL_MS);
		socket.on('pong', () => (alive = true));

		socket.on('message', (data) => {
			const message = decode(data);
			switch (message?.case) {
				case 'response':
					connection.pending.get(message.value.requestId)?.(toRpcResult(message.value.result));
					break;
				case 'prekey':
					connection.prekey = message.value.publicKey.slice();
					break;
			}
		});

		socket.on('close', () => {
			clearInterval(pinger);
			clearInterval(seen);
			markSeen(connectorId);
			if (connections.get(connectorId) === connection) connections.delete(connectorId);
			for (const resolve of connection.pending.values()) resolve({ status: 'offline' });
		});
	};

	const accept = (socket: WebSocket) => {
		const timer = setTimeout(() => socket.terminate(), HELLO_TIMEOUT_MS);
		socket.once('message', async (data) => {
			clearTimeout(timer);
			const message = decode(data);
			if (message?.case !== 'hello') return socket.terminate();
			const { protocolVersion, connectorVersion, connectorId, token } = message.value;
			if (!SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
				return close(
					socket,
					Close_Reason.UPDATE_REQUIRED,
					`Relay protocol version ${protocolVersion} is no longer supported. Update the connector.`
				);
			}
			const verified = await verifyConnector(connectorId, token).catch(() => undefined);
			if (verified === undefined) return socket.terminate();
			if (!verified)
				return close(socket, Close_Reason.UNAUTHORIZED, 'Unknown connector ID or token.');
			register(connectorId, connectorVersion, socket);
		});
	};

	const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
		if (new URL(request.url ?? '/', 'http://relay').pathname !== CONNECTOR_PATH) return false;
		server.handleUpgrade(request, socket, head, accept);
		return true;
	};

	const rpc = (connectorId: string, sealed: Uint8Array) =>
		new Promise<RpcResult>((resolve) => {
			const connection = connections.get(connectorId);
			if (!connection) return resolve({ status: 'offline' });
			const id = nextRequestId++;
			const timer = setTimeout(() => settle({ status: 'timeout' }), REQUEST_TIMEOUT_MS);
			const settle = (result: RpcResult) => {
				clearTimeout(timer);
				connection.pending.delete(id);
				resolve(result);
			};
			connection.pending.set(id, settle);
			send(connection.socket, {
				case: 'request',
				value: create(RequestSchema, { id, sealed })
			});
		});

	const isOnline = (connectorId: string) => connections.has(connectorId);

	const prekey = (connectorId: string) => connections.get(connectorId)?.prekey;

	return { handleUpgrade, rpc, isOnline, prekey };
};

export type Relay = ReturnType<typeof createRelay>;

export const relay = (globalThis.dbgopherRelay ??= createRelay());
