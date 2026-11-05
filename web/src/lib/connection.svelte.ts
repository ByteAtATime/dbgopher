import { untrack } from 'svelte';
import { browseKey, createBrowseCache, type BrowseResult } from './browse-cache.ts';
import {
	createClient,
	type Browse,
	type BrowseOptions,
	type Client,
	type Hello,
	type Overview,
	type SearchOptions
} from './protocol/client.ts';

const POLL_INTERVAL_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const REVALIDATE_AFTER_MS = POLL_INTERVAL_MS;

export type Status =
	{ type: 'connecting' } | { type: 'online'; hello: Hello } | { type: 'unavailable'; error: Error };

export type OverviewState =
	{ type: 'loading' } | { type: 'loaded'; overview: Overview } | { type: 'failed'; error: Error };

export type RowsState =
	| { type: 'loading'; previous?: Browse }
	| { type: 'loaded'; rows: Browse }
	| { type: 'failed'; error: Error };

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

const browse = async (client: Client, options: BrowseOptions): Promise<BrowseResult> => {
	try {
		return { type: 'loaded', rows: await client.browse(options) };
	} catch (error) {
		return { type: 'failed', error: toError(error) };
	}
};

export const createConnection = (
	connectorId: string,
	connectorKey: Uint8Array,
	prekey?: Uint8Array
) => {
	let status = $state<Status>({ type: 'connecting' });
	let overview = $state<OverviewState>({ type: 'loading' });
	let rows = $state<RowsState>({ type: 'loading' });
	let target: BrowseOptions | undefined;
	let validated: string | undefined;
	let checking: Promise<Status> | undefined;
	const client = createClient({ connectorId, connectorKey, prekey });
	const cache = createBrowseCache({
		load: (options) => browse(client, options),
		ttl: CACHE_TTL_MS
	});
	let stopped = false;

	const online = async () => (await checking)?.type === 'online';

	const loadOverview = async () => {
		if (overview.type === 'loaded') return;
		const loaded = await load(client);
		if (loaded.type === 'failed' && !(await online())) return;
		if (!stopped) overview = loaded;
	};

	let reloading: Promise<void> | undefined;

	const reloadOverview = () =>
		(reloading ??= load(client).then((loaded) => {
			reloading = undefined;
			if (!stopped && loaded.type === 'loaded') overview = loaded;
		}));

	const refresh = async () => {
		const current = target;
		if (!current) return;
		const key = browseKey(current);
		if (rows.type === 'loaded' && validated === key) return;
		const result = await cache.fetch(current);
		if (result.type === 'failed' && !(await online())) return;
		if (stopped || target !== current) return;
		validated = key;
		if (
			result.type === 'loaded' &&
			rows.type === 'loaded' &&
			JSON.stringify(result.rows) === JSON.stringify(rows.rows)
		)
			return;
		rows = result;
	};

	const select = (next: BrowseOptions | undefined) => {
		if ((target && browseKey(target)) === (next && browseKey(next))) return;
		const sameTable = target?.schema === next?.schema && target?.table === next?.table;
		target = next;
		const hit = next && cache.get(next);
		validated =
			next && hit && Date.now() - hit.at < REVALIDATE_AFTER_MS ? browseKey(next) : undefined;
		rows = hit
			? { type: 'loaded', rows: hit.rows }
			: {
					type: 'loading',
					previous: !sameTable
						? undefined
						: rows.type === 'loaded'
							? rows.rows
							: rows.type === 'loading'
								? rows.previous
								: undefined
				};
		void refresh();
	};

	const seed = (options: BrowseOptions, rows: Browse) => {
		if (!cache.get(options)) cache.set(options, rows);
	};

	const prefetch = (options: BrowseOptions) => {
		if (status.type !== 'online' || cache.get(options)) return;
		void cache.fetch(options);
	};

	const start = () => {
		let timer: ReturnType<typeof setTimeout> | undefined;

		const poll = async () => {
			checking = check(client);
			await Promise.all([
				checking.then((next) => {
					if (!stopped) status = next;
				}),
				loadOverview(),
				refresh()
			]);
			if (stopped) return;
			timer = setTimeout(poll, POLL_INTERVAL_MS);
		};

		void untrack(poll);

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
		prefetch,
		seed,
		reloadOverview,
		search: (options: SearchOptions) => client.search(options),
		start
	};
};
