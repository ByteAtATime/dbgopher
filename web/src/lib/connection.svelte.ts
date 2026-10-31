import type { Table } from './protocol/bindings/Table.ts';
import {
	createClient,
	type Browse,
	type Client,
	type Hello,
	type Overview
} from './protocol/client.ts';

const POLL_INTERVAL_MS = 10_000;

export type Status =
	{ type: 'connecting' } | { type: 'online'; hello: Hello } | { type: 'unavailable'; error: Error };

export type OverviewState =
	{ type: 'loading' } | { type: 'loaded'; overview: Overview } | { type: 'failed'; error: Error };

export type RowsState =
	{ type: 'loading' } | { type: 'loaded'; rows: Browse } | { type: 'failed'; error: Error };

const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

const check = async (client: Client): Promise<Status> => {
	try {
		return { type: 'online', hello: await client.hello() };
	} catch (error) {
		return { type: 'unavailable', error: toError(error) };
	}
};

const load = async (client: Client): Promise<OverviewState> => {
	try {
		return { type: 'loaded', overview: await client.overview() };
	} catch (error) {
		return { type: 'failed', error: toError(error) };
	}
};

const browse = async (client: Client, table: Table): Promise<RowsState> => {
	try {
		return {
			type: 'loaded',
			rows: await client.browse({ schema: table.schema, table: table.name })
		};
	} catch (error) {
		return { type: 'failed', error: toError(error) };
	}
};

export const createConnection = (connectorId: string, connectorKey: Uint8Array) => {
	let status = $state<Status>({ type: 'connecting' });
	let overview = $state<OverviewState>({ type: 'loading' });
	let rows = $state<RowsState>({ type: 'loading' });

	const start = () => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const poll = async (client: Client) => {
			const next = await check(client);
			if (stopped) return;
			status = next;
			if (status.type === 'online' && overview.type !== 'loaded') {
				const loaded = await load(client);
				if (stopped) return;
				overview = loaded;
			}
			const [first] = overview.type === 'loaded' ? overview.overview.tables : [];
			if (status.type === 'online' && first && rows.type !== 'loaded') {
				const browsed = await browse(client, first);
				if (stopped) return;
				rows = browsed;
			}
			timer = setTimeout(() => poll(client), POLL_INTERVAL_MS);
		};

		createClient({ connectorId, connectorKey }).then(poll, (error) => {
			status = { type: 'unavailable', error: toError(error) };
		});

		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	};

	return {
		get status() {
			return status;
		},
		get overview() {
			return overview;
		},
		get rows() {
			return rows;
		},
		start
	};
};
