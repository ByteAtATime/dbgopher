import {
	createClient,
	type Browse,
	type BrowseOptions,
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

const browse = async (client: Client, options: BrowseOptions): Promise<RowsState> => {
	try {
		return { type: 'loaded', rows: await client.browse(options) };
	} catch (error) {
		return { type: 'failed', error: toError(error) };
	}
};

export const createConnection = (connectorId: string, connectorKey: Uint8Array) => {
	let status = $state<Status>({ type: 'connecting' });
	let overview = $state<OverviewState>({ type: 'loading' });
	let rows = $state<RowsState>({ type: 'loading' });
	let target: BrowseOptions | undefined;
	let browsing: BrowseOptions | undefined;
	let client: Client | undefined;
	let stopped = false;

	const refresh = async () => {
		const current = target;
		if (!client || !current || browsing === current) return;
		if (status.type !== 'online' || rows.type === 'loaded') return;
		browsing = current;
		const browsed = await browse(client, current);
		if (browsing === current) browsing = undefined;
		if (stopped || target !== current) return;
		rows = browsed;
	};

	const select = (next: BrowseOptions | undefined) => {
		if (
			target?.schema === next?.schema &&
			target?.table === next?.table &&
			target?.limit === next?.limit &&
			target?.offset === next?.offset &&
			target?.sort?.column === next?.sort?.column &&
			target?.sort?.direction === next?.sort?.direction
		)
			return;
		target = next;
		rows = { type: 'loading' };
		void refresh();
	};

	const start = () => {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const poll = async () => {
			if (!client) return;
			const next = await check(client);
			if (stopped) return;
			status = next;
			if (status.type === 'online' && overview.type !== 'loaded') {
				const loaded = await load(client);
				if (stopped) return;
				overview = loaded;
			}
			await refresh();
			if (stopped) return;
			timer = setTimeout(poll, POLL_INTERVAL_MS);
		};

		createClient({ connectorId, connectorKey }).then(
			(created) => {
				client = created;
				return poll();
			},
			(error) => {
				status = { type: 'unavailable', error: toError(error) };
			}
		);

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
		select,
		start
	};
};
