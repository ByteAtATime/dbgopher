import { z } from 'zod';
import type { Capability } from './bindings/Capability';
import type { Column } from './bindings/Column';
import type { ForeignKey } from './bindings/ForeignKey';
import type { Request } from './bindings/Request';
import type { Response as ConnectorResponse } from './bindings/Response';
import type { Table } from './bindings/Table';
import { createChannel } from './channel';

export type Hello = Extract<ConnectorResponse, { type: 'hello' }>;
export type Overview = Extract<ConnectorResponse, { type: 'overview' }>;
export type Browse = Extract<ConnectorResponse, { type: 'browse' }>;
export type BrowseOptions = Omit<Extract<Request, { type: 'browse' }>, 'type'>;

export type RelayErrorReason =
	| 'unreachable'
	| 'offline'
	| 'timeout'
	| 'tooLarge'
	| 'undecryptable'
	| 'expired'
	| 'replayed'
	| 'malformed'
	| 'rejected'
	| 'unexpected';

export class RelayError extends Error {
	readonly reason: RelayErrorReason;

	constructor(reason: RelayErrorReason, message: string) {
		super(message);
		this.name = 'RelayError';
		this.reason = reason;
	}
}

export class ConnectorError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConnectorError';
	}
}

export type Fetch = (path: string, init: RequestInit) => Promise<Response>;

export type ClientOptions = {
	connectorId: string;
	connectorKey: Uint8Array;
	fetch?: Fetch;
};

const CAPABILITIES = ['overview', 'browse'] as const satisfies readonly Capability[];

const isCapability = (value: string): value is Capability =>
	CAPABILITIES.some((capability) => capability === value);

const columnSchema = z.object({
	name: z.string(),
	typeOid: z.number(),
	typeName: z.string(),
	nullable: z.boolean(),
	hasDefault: z.boolean()
}) satisfies z.ZodType<Column>;

const foreignKeySchema = z.object({
	name: z.string(),
	columns: z.array(z.string()),
	referencedSchema: z.string(),
	referencedTable: z.string(),
	referencedColumns: z.array(z.string())
}) satisfies z.ZodType<ForeignKey>;

const tableSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: z.enum(['table', 'partitionedTable', 'view', 'materializedView', 'foreignTable']),
	rowCount: z.number().nullable(),
	rowCountExact: z.boolean(),
	totalBytes: z.number(),
	columns: z.array(columnSchema),
	primaryKey: z.array(z.string()),
	foreignKeys: z.array(foreignKeySchema)
}) satisfies z.ZodType<Table>;

const helloSchema = z.object({
	type: z.literal('hello'),
	protocolVersion: z.number(),
	connectorVersion: z.string(),
	capabilities: z.array(z.string()).transform((values) => values.filter(isCapability)),
	readOnly: z.boolean()
}) satisfies z.ZodType<Hello>;

const overviewSchema = z.object({
	type: z.literal('overview'),
	tables: z.array(tableSchema)
}) satisfies z.ZodType<Overview>;

const browseSchema = z.object({
	type: z.literal('browse'),
	columns: z.array(columnSchema),
	rows: z.array(z.array(z.string().nullable()))
}) satisfies z.ZodType<Browse>;

const errorSchema = z.object({
	type: z.literal('error'),
	message: z.string()
}) satisfies z.ZodType<Extract<ConnectorResponse, { type: 'error' }>>;

const rejectionSchema = z.object({ rejection: z.string() });

const REJECTIONS = new Map<string, [RelayErrorReason, string]>([
	[
		'UNDECRYPTABLE',
		[
			'undecryptable',
			"The connector could not decrypt the request. Check that the key matches the connector's CONNECTOR_KEY."
		]
	],
	[
		'EXPIRED',
		[
			'expired',
			'The connector rejected the request as expired. Check the clocks on this device and on the connector.'
		]
	],
	['REPLAYED', ['replayed', 'The connector rejected the request as a replay.']],
	['MALFORMED', ['malformed', 'The connector could not read the request. It may need updating.']]
]);

const toRelayError = async (response: Response) => {
	switch (response.status) {
		case 503:
			return new RelayError('offline', 'The connector is not connected to the relay.');
		case 504:
			return new RelayError('timeout', 'The connector did not respond in time.');
		case 413:
			return new RelayError('tooLarge', 'The request is too large for the relay.');
		case 422: {
			const body = rejectionSchema.safeParse(await response.json().catch(() => undefined));
			const known = body.success ? REJECTIONS.get(body.data.rejection) : undefined;
			const [reason, message] = known ?? ['rejected', 'The connector rejected the request.'];
			return new RelayError(reason, message);
		}
		default:
			return new RelayError('unexpected', `The relay responded with status ${response.status}.`);
	}
};

export const createClient = async ({
	connectorId,
	connectorKey,
	fetch = globalThis.fetch
}: ClientOptions) => {
	const channel = await createChannel(connectorKey, connectorId);
	const sessionId = crypto.randomUUID();

	const call = async <T>(body: Request, schema: z.ZodType<T>) => {
		const { id, sealed } = channel.sealRequest(body);
		const response = await fetch(`/v1/connectors/${encodeURIComponent(connectorId)}/rpc`, {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream', 'x-session-id': sessionId },
			body: new Uint8Array(sealed)
		}).catch(() => {
			throw new RelayError('unreachable', 'Could not reach the relay.');
		});
		if (!response.ok) throw await toRelayError(response);

		const opened = channel.openResponse(id, new Uint8Array(await response.arrayBuffer()));
		const error = errorSchema.safeParse(opened);
		if (error.success) throw new ConnectorError(error.data.message);
		const result = schema.safeParse(opened);
		if (!result.success) {
			throw new Error(
				`The connector sent a response this app does not understand. One of them may be outdated. ${z.prettifyError(result.error)}`
			);
		}
		return result.data;
	};

	return {
		hello: () => call({ type: 'hello' }, helloSchema),
		overview: () => call({ type: 'overview' }, overviewSchema),
		browse: (options: BrowseOptions) => call({ type: 'browse', ...options }, browseSchema)
	};
};

export type Client = Awaited<ReturnType<typeof createClient>>;
