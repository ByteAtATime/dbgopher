import { describe, expect, it, vi } from 'vitest';
import { createBrowseCache, type BrowseResult } from './browse-cache';
import type { Browse, BrowseOptions } from './protocol/client';

const TTL = 5 * 60_000;

const page = (id: string): Browse => ({
	type: 'browse',
	columns: [],
	rows: [[{ kind: 'text', text: id }]]
});

const loaded = (id: string): BrowseResult => ({ type: 'loaded', rows: page(id) });

const setup = (load: (options: BrowseOptions) => Promise<BrowseResult>) => {
	let time = 0;
	const cache = createBrowseCache({ load, ttl: TTL, now: () => time });
	return { cache, advance: (ms: number) => (time += ms) };
};

const products = (value: string): BrowseOptions => ({
	schema: 'public',
	table: 'products',
	limit: 50,
	offset: 0,
	filter: [{ column: 'category_id', value }]
});

describe('createBrowseCache', () => {
	it('serves loaded rows until they are five minutes old', async () => {
		const { cache, advance } = setup(async () => loaded('1'));
		await cache.fetch(products('1'));
		advance(TTL - 1);
		expect(cache.get(products('1'))).toEqual({ rows: page('1'), at: 0 });
		advance(1);
		expect(cache.get(products('1'))).toBeUndefined();
	});

	it('keeps different filters apart', async () => {
		const { cache } = setup(async (options) => loaded(options.filter?.[0]?.value ?? ''));
		await cache.fetch(products('1'));
		expect(cache.get(products('2'))).toBeUndefined();
	});

	it('shares one request between a prefetch and the visit that follows it', async () => {
		const load = vi.fn(async () => loaded('1'));
		const { cache } = setup(load);
		const [prefetched, visited] = await Promise.all([
			cache.fetch(products('1')),
			cache.fetch(products('1'))
		]);
		expect(load).toHaveBeenCalledTimes(1);
		expect(visited).toBe(prefetched);
	});

	it('does not keep failures', async () => {
		const load = vi.fn(async (): Promise<BrowseResult> => ({
			type: 'failed',
			error: new Error('x')
		}));
		const { cache } = setup(load);
		await cache.fetch(products('1'));
		expect(cache.get(products('1'))).toBeUndefined();
		await cache.fetch(products('1'));
		expect(load).toHaveBeenCalledTimes(2);
	});
});
