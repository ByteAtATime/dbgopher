import type { Column } from '../protocol/bindings/Column';
import type { Filter } from '../protocol/bindings/Filter';
import type { PaletteOutcome } from '../protocol/bindings/PaletteOutcome';
import type { PaletteTarget } from '../protocol/bindings/PaletteTarget';
import type { Palette, Value } from '../protocol/client';
import type { Coverage, Target } from './plan';
import type { Hit } from './rank';

export type Found = { columns: Column[]; values: (Value | null)[] };

export type Failure = { target: Target; outcome: Exclude<PaletteOutcome, { kind: 'rows' }> };

export type Results = { hits: Hit<Found>[]; failures: Failure[] };

export type Search = (targets: PaletteTarget[]) => Promise<Palette>;

const DISPLAY = /^(name|title|email|status|created_at)$|_name$/;
const PREVIEW_COLUMNS = 4;

const request = ({ schema, table, column, comparison, value }: Target): PaletteTarget => ({
	schema,
	table,
	column,
	comparison,
	value
});

const settle = (results: Results, target: Target, outcome: Palette['outcomes'][number]) => {
	if (outcome.kind === 'rows') {
		const rows = outcome.rows.map((values) => ({ columns: outcome.columns, values }));
		return { ...results, hits: [...results.hits, { target, rows }] };
	}
	return {
		hits: [...results.hits, { target, rows: [] }],
		failures: [...results.failures, { target, outcome }]
	};
};

export const execute = async (targets: Target[], search: Search) => {
	const empty: Results = { hits: [], failures: [] };
	if (targets.length === 0) return empty;
	const { outcomes } = await search(targets.map(request));
	return outcomes.reduce(
		(results, outcome, index) => settle(results, targets[index], outcome),
		empty
	);
};

const text = (found: Found, column: string) => {
	const value = found.values[found.columns.findIndex(({ name }) => name === column)];
	return value?.kind === 'text' ? value.text : undefined;
};

export const rowFilter = (primaryKey: string[], target: Target, found: Found): Filter[] => {
	const key = primaryKey.flatMap((column) => {
		const value = text(found, column);
		return value === undefined ? [] : [{ column, value }];
	});
	if (primaryKey.length > 0 && key.length === primaryKey.length) return key;
	return [{ column: target.column, value: text(found, target.column) ?? target.value }];
};

export const preview = (primaryKey: string[], target: Target, found: Found) => {
	const names = [
		...primaryKey,
		target.column,
		...found.columns.map(({ name }) => name).filter((name) => DISPLAY.test(name))
	];
	return [...new Set(names)]
		.slice(0, PREVIEW_COLUMNS)
		.map((name) => ({
			column: name,
			value: found.values[found.columns.findIndex((column) => column.name === name)]
		}))
		.filter(({ value }) => value !== undefined);
};

export const failedTables = (coverage: Coverage[], failed: { schema: string; table: string }[]) =>
	new Set(
		[...coverage.filter(({ kind }) => kind === 'unreadable'), ...failed].map(({ schema, table }) =>
			JSON.stringify([schema, table])
		)
	).size;

export const tableLabel = (
	schema: string,
	table: string,
	tables: { schema: string; name: string }[]
) =>
	tables.some((other) => other.name === table && other.schema !== schema)
		? `${schema}.${table}`
		: table;
