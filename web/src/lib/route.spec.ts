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
			table: 'orders'
		});
	});
});

describe('formatRoute', () => {
	it.each<Route>([
		{ type: 'tables' },
		{ type: 'browse', schema: 'public', table: 'orders' },
		{ type: 'browse', schema: 'audit', table: 'Event Log' },
		{ type: 'browse', schema: 'we/ird', table: '#%?' }
	])('round-trips %j', (route) => {
		expect(parseRoute(formatRoute(route))).toEqual(route);
	});
});
