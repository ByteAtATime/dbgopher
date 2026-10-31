export type Route = { type: 'tables' } | { type: 'browse'; schema: string; table: string };

const TABLES: Route = { type: 'tables' };

export const parseRoute = (fragment: string): Route => {
	const [root, kind, schema, table, ...rest] = fragment.split('/');
	if (root !== '' || kind !== 't' || !schema || !table || rest.length > 0) return TABLES;
	try {
		return {
			type: 'browse',
			schema: decodeURIComponent(schema),
			table: decodeURIComponent(table)
		};
	} catch {
		return TABLES;
	}
};

export const formatRoute = (route: Route) =>
	route.type === 'tables'
		? '/'
		: `/t/${encodeURIComponent(route.schema)}/${encodeURIComponent(route.table)}`;
