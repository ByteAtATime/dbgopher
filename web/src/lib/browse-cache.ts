import type { Browse, BrowseOptions } from './protocol/client';

export type BrowseResult = { type: 'loaded'; rows: Browse } | { type: 'failed'; error: Error };

type CacheOptions = {
	load: (options: BrowseOptions) => Promise<BrowseResult>;
	ttl: number;
	now?: () => number;
};

export const browseKey = (options: BrowseOptions) =>
	JSON.stringify([
		options.schema,
		options.table,
		options.limit,
		options.offset,
		options.sort?.column,
		options.sort?.direction,
		(options.filter ?? []).map(({ column, value }) => [column, value])
	]);

export const createBrowseCache = ({ load, ttl, now = Date.now }: CacheOptions) => {
	const entries = new Map<string, { rows: Browse; at: number }>();
	const pending = new Map<string, Promise<BrowseResult>>();

	const get = (options: BrowseOptions) => {
		const time = now();
		for (const [key, { at }] of entries) if (time - at >= ttl) entries.delete(key);
		return entries.get(browseKey(options));
	};

	const fetch = (options: BrowseOptions) => {
		const key = browseKey(options);
		const existing = pending.get(key);
		if (existing) return existing;
		const request = load(options).then((result) => {
			pending.delete(key);
			if (result.type === 'loaded') entries.set(key, { rows: result.rows, at: now() });
			return result;
		});
		pending.set(key, request);
		return request;
	};

	const set = (options: BrowseOptions, rows: Browse) => {
		const key = browseKey(options);
		if (!pending.has(key)) entries.set(key, { rows, at: now() });
	};

	return { get, fetch, set };
};
