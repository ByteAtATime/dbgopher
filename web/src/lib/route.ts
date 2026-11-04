import type { Filter } from './protocol/bindings/Filter';

export type Route =
	{ type: 'tables' } | { type: 'browse'; schema: string; table: string; filter: Filter[] };

const TABLES: Route = { type: 'tables' };

export const parseRoute = (fragment: string): Route => {
	const [path, ...query] = fragment.split('?');
	const [root, kind, schema, table, ...rest] = path.split('/');
	if (root !== '' || kind !== 't' || !schema || !table || rest.length > 0) return TABLES;
	try {
		return {
			type: 'browse',
			schema: decodeURIComponent(schema),
			table: decodeURIComponent(table),
			filter: [...new URLSearchParams(query.join('?'))].map(([column, value]) => ({
				column,
				value
			}))
		};
	} catch {
		return TABLES;
	}
};

export const formatRoute = (route: Route) => {
	if (route.type === 'tables') return '/';
	const path = `/t/${encodeURIComponent(route.schema)}/${encodeURIComponent(route.table)}`;
	if (route.filter.length === 0) return path;
	return `${path}?${new URLSearchParams(route.filter.map(({ column, value }) => [column, value]))}`;
};
