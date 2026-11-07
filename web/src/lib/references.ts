import type { Filter } from './protocol/bindings/Filter';
import type { Table } from './protocol/bindings/Table';
import type { Browse } from './protocol/client';

export type Reference = {
	label: string;
	schema: string;
	table: string;
	columns: string[];
	referencedColumns: string[];
};

export const incomingReferences = (tables: Table[], schema: string, table: string) => {
	const incoming = tables.flatMap((source) =>
		source.foreignKeys
			.filter((key) => key.referencedSchema === schema && key.referencedTable === table)
			.map((key) => ({ source, key }))
	);
	return incoming
		.map(({ source, key }) => {
			const name = source.schema === schema ? source.name : `${source.schema}.${source.name}`;
			const ambiguous = incoming.filter((other) => other.source === source).length > 1;
			const self = source.schema === schema && source.name === table;
			const reference: Reference = {
				label: ambiguous || self ? `${name}.${key.columns.join(', ')}` : name,
				schema: source.schema,
				table: source.name,
				columns: key.columns,
				referencedColumns: key.referencedColumns
			};
			return { reference, rank: self ? 0 : ambiguous ? 1 : 2 };
		})
		.sort((a, b) => a.rank - b.rank)
		.map(({ reference }) => reference);
};

export const outgoingReferences = (tables: Table[], schema: string, table: string) =>
	(
		tables.find((source) => source.schema === schema && source.name === table)?.foreignKeys ?? []
	).map((key): Reference => ({
		label:
			key.referencedSchema === schema
				? key.referencedTable
				: `${key.referencedSchema}.${key.referencedTable}`,
		schema: key.referencedSchema,
		table: key.referencedTable,
		columns: key.referencedColumns,
		referencedColumns: key.columns
	}));

export const referenceFilter = (
	reference: Reference,
	rows: Browse,
	row: number
): Filter[] | undefined => {
	const filter: Filter[] = [];
	for (const [index, column] of reference.columns.entries()) {
		const position = rows.columns.findIndex(
			({ name }) => name === reference.referencedColumns[index]
		);
		const value = rows.rows[row]?.[position];
		if (value?.kind !== 'text') return undefined;
		filter.push({ column, value: value.text });
	}
	return filter;
};
