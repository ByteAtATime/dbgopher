import { z } from 'zod';

const Widths = z.record(z.string(), z.number().finite().positive());

export type ColumnWidthsScope = { connectorId: string; schema: string; table: string };

const storageKey = ({ connectorId, schema, table }: ColumnWidthsScope) =>
	`dbgopher:column-widths:${JSON.stringify([connectorId, schema, table])}`;

const read = (scope: ColumnWidthsScope) => {
	try {
		const parsed = Widths.safeParse(JSON.parse(localStorage.getItem(storageKey(scope)) ?? '{}'));
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
};

export const loadColumnWidths = (scope: ColumnWidthsScope) => new Map(Object.entries(read(scope)));

export const saveColumnWidth = (scope: ColumnWidthsScope, column: string, width: number) => {
	try {
		localStorage.setItem(storageKey(scope), JSON.stringify({ ...read(scope), [column]: width }));
	} catch {
		return;
	}
};
