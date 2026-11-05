import type { Table } from '../protocol/bindings/Table';
import type { Hit } from './rank';

const DISPLAY = [
	'name',
	'title',
	'display_name',
	'full_name',
	'username',
	'email',
	'label',
	'slug',
	'status',
	'state',
	'type',
	'kind',
	'created_at'
];
const MAX_DISPLAY = 3;
const MIN_NAMED = 2;
const MAX_FALLBACK_LENGTH = 80;

export const tableLabel = (table: Table, tables: Table[]) =>
	tables.some((other) => other.name === table.name && other.schema !== table.schema)
		? `${table.schema}.${table.name}`
		: table.name;

export const preview = (hit: Hit) => {
	const values = hit.columns.map((column, index) => {
		const cell = hit.cells[index];
		return { column, value: cell?.kind === 'text' ? cell.text : undefined };
	});
	const candidates = values.filter(
		({ column, value }) =>
			value !== undefined && value !== '' && !hit.table.primaryKey.includes(column)
	);
	const named = DISPLAY.flatMap((name) =>
		candidates.filter(({ column }) => column.toLowerCase() === name)
	).slice(0, MAX_DISPLAY);
	const fallback =
		named.length >= MIN_NAMED
			? []
			: candidates.filter(
					(entry) => !named.includes(entry) && (entry.value?.length ?? 0) <= MAX_FALLBACK_LENGTH
				);
	return [...named, ...fallback].slice(0, MAX_DISPLAY).map(({ column, value }) => ({
		column,
		value: value ?? ''
	}));
};
