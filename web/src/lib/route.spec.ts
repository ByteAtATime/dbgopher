import { describe, expect, it } from 'vitest';
import { parseRoute, formatRoute, type Route } from './route';

describe('parseRoute', () => {
	it.each(['', '/', '/t', '/t/public', '/t/public/', '/t/a/b/c', '/x/a/b', 't/a/b', '/t/%E0/b'])(
		'falls back to the table list for %j',
		(fragment) => {
			expect(parseRoute(fragment)).toEqual({ type: 'tables' });
		}
	);

	it('parses a table', () => {
		expect(parseRoute('/t/public/orders')).toEqual({
			type: 'browse',
			schema: 'public',
			table: 'orders',
			filter: []
		});
	});

	it('parses a filtered table', () => {
		expect(parseRoute('/t/public/orders?customer_id=1&note=a+b%2Bc%3Dd')).toEqual({
			type: 'browse',
			schema: 'public',
			table: 'orders',
			filter: [
				{ column: 'customer_id', value: '1' },
				{ column: 'note', value: 'a b+c=d' }
			]
		});
	});
});

describe('formatRoute', () => {
	it.each<Route>([
		{ type: 'tables' },
		{ type: 'browse', schema: 'public', table: 'orders', filter: [] },
		{ type: 'browse', schema: 'audit', table: 'Event Log', filter: [] },
		{ type: 'browse', schema: 'we/ird', table: '#%?', filter: [] },
		{
			type: 'browse',
			schema: 'public',
			table: 'order_items',
			filter: [
				{ column: 'order_id', value: '1' },
				{ column: 'we?ird&', value: '{"a": "b c"}' }
			]
		}
	])('round-trips %j', (route) => {
		expect(parseRoute(formatRoute(route))).toEqual(route);
	});
});
