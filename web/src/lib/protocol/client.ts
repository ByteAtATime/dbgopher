import { z } from 'zod';
import type { Capability } from './bindings/Capability';
import type { Cell } from './bindings/Cell';
import type { Column } from './bindings/Column';
import type { UnreadableTable } from './bindings/UnreadableTable';
import type { ForeignKey } from './bindings/ForeignKey';
import type { Index } from './bindings/Index';
import type { PaletteOutcome } from './bindings/PaletteOutcome';
import type { PaletteTarget } from './bindings/PaletteTarget';
import type { Request } from './bindings/Request';
import type { Response as ConnectorResponse } from './bindings/Response';
import type { Table } from './bindings/Table';
import { createChannel } from './channel';

export type Hello = Extract<ConnectorResponse, { type: 'hello' }>;
export type Overview = Extract<ConnectorResponse, { type: 'overview' }>;
export type Browse = z.output<typeof browseSchema>;
export type Value = z.output<typeof valueSchema>;
export type Palette = z.output<typeof paletteSchema>;
export type BrowseOptions = Omit<Extract<Request, { type: 'browse' }>, 'type'>;

export type RelayErrorReason =
	| 'unreachable'
	| 'offline'
	| 'timeout'
	| 'tooLarge'
	| 'undecryptable'
	| 'expired'
	| 'replayed'
	| 'staleKey'
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
	prekey?: Uint8Array;
	fetch?: Fetch;
};

const CAPABILITIES = ['overview', 'browse', 'palette'] as const satisfies readonly Capability[];

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

const indexSchema = z.object({
	name: z.string(),
	method: z.string(),
	unique: z.boolean(),
	partial: z.boolean(),
	keys: z.array(
		z.discriminatedUnion('kind', [
			z.object({ kind: z.literal('column'), name: z.string(), operatorClass: z.string() }),
			z.object({
				kind: z.literal('expression'),
				definition: z.string(),
				typeOid: z.number(),
				typeName: z.string(),
				operatorClass: z.string()
			})
		])
	)
}) satisfies z.ZodType<Index>;

const tableKindSchema = z.enum([
	'table',
	'partitionedTable',
	'view',
	'materializedView',
	'foreignTable'
]);

const tableSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: tableKindSchema,
	rowCount: z.number().nullable(),
	rowCountExact: z.boolean(),
	totalBytes: z.number(),
	columns: z.array(columnSchema),
	primaryKey: z.array(z.string()),
	foreignKeys: z.array(foreignKeySchema),
	indexes: z.array(indexSchema)
}) satisfies z.ZodType<Table>;

const unreadableTableSchema = z.object({
	schema: z.string(),
	name: z.string(),
	kind: tableKindSchema
}) satisfies z.ZodType<UnreadableTable>;

const helloSchema = z.object({
	type: z.literal('hello'),
	protocolVersion: z.number(),
	connectorVersion: z.string(),
	capabilities: z.array(z.string()).transform((values) => values.filter(isCapability)),
	readOnly: z.boolean()
}) satisfies z.ZodType<Hello>;

const overviewSchema = z.object({
	type: z.literal('overview'),
	searchPath: z.array(z.string()),
	fingerprint: z.string(),
	tables: z.array(tableSchema),
	unreadableTables: z.array(unreadableTableSchema)
}) satisfies z.ZodType<Overview>;

const valueSchema = z.union([
	z.string().transform((text) => ({ kind: 'text' as const, text })),
	z.object({ bytes: z.number() }).transform(({ bytes }) => ({ kind: 'binary' as const, bytes }))
]) satisfies z.ZodType<unknown, Cell>;

const rowsShape = {
	columns: z.array(columnSchema),
	rows: z.array(z.array(valueSchema.nullable()))
};

const browseSchema = z.object({
	type: z.literal('browse'),
	...rowsShape
}) satisfies z.ZodType<unknown, Extract<ConnectorResponse, { type: 'browse' }>>;

const outcomeSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('rows'), ...rowsShape }),
	z.object({ kind: z.literal('timedOut') }),
	z.object({ kind: z.literal('denied') }),
	z.object({ kind: z.literal('failed'), message: z.string() })
]) satisfies z.ZodType<unknown, PaletteOutcome>;

const paletteSchema = z.object({
	type: z.literal('palette'),
	outcomes: z.array(outcomeSchema)
}) satisfies z.ZodType<unknown, Extract<ConnectorResponse, { type: 'palette' }>>;

const errorSchema = z.object({
	type: z.literal('error'),
	message: z.string()
}) satisfies z.ZodType<Extract<ConnectorResponse, { type: 'error' }>>;

const rejectionSchema = z.object({ rejection: z.string() });

const REJECTED = 'The connector rejected the request.';

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
	['STALE_KEY', ['staleKey', REJECTED]],
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
			const [reason, message] = known ?? ['rejected', REJECTED];
			return new RelayError(reason, message);
		}
		default:
			return new RelayError('unexpected', `The relay responded with status ${response.status}.`);
	}
};

export const createClient = ({
	connectorId,
	connectorKey,
	prekey,
	fetch = globalThis.fetch
}: ClientOptions) => {
	const relay = async (path: string, init: RequestInit) => {
		const response = await fetch(
			`/v1/connectors/${encodeURIComponent(connectorId)}/${path}`,
			init
		).catch(() => {
			throw new RelayError('unreachable', 'Could not reach the relay.');
		});
		if (!response.ok) throw await toRelayError(response);
		return new Uint8Array(await response.arrayBuffer());
	};

	const post = (sealed: Uint8Array) =>
		relay('rpc', {
			method: 'POST',
			headers: { 'content-type': 'application/octet-stream' },
			body: new Uint8Array(sealed)
		});

	let channel: ReturnType<typeof createChannel> | undefined;

	const open = async (known?: Uint8Array) =>
		createChannel(connectorKey, connectorId, known ?? (await relay('prekey', { method: 'GET' })));

	const connect = (known?: Uint8Array) => {
		const pending = open(known);
		channel = pending;
		pending.catch(() => {
			if (channel === pending) channel = undefined;
		});
		return pending;
	};

	if (prekey) connect(prekey);

	const send = async (body: Request, retry = true): Promise<unknown> => {
		const pending = channel ?? connect();
		const { sealRequest, openResponse } = await pending;
		const { id, sealed } = sealRequest(body);
		try {
			return openResponse(id, await post(sealed));
		} catch (error) {
			if (!retry || !(error instanceof RelayError) || error.reason !== 'staleKey') throw error;
			if (channel === pending) channel = undefined;
			return send(body, false);
		}
	};

	const call = async <T>(body: Request, schema: z.ZodType<T>) => {
		const opened = await send(body);
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
		browse: (options: BrowseOptions) => call({ type: 'browse', ...options }, browseSchema),
		palette: (targets: PaletteTarget[]) => call({ type: 'palette', targets }, paletteSchema)
	};
};

export type Client = ReturnType<typeof createClient>;
