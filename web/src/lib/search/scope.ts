import type { Table } from '../protocol/bindings/Table';
import type { Hint } from './detect';

export const tableKey = (table: { schema: string; name: string }) =>
	`${table.schema}.${table.name}`;

export const singular = (word: string) => {
	const lower = word.toLowerCase();
	if (lower.length > 4 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
	if (/(ss|x|ch|sh|zz|us)es$/.test(lower)) return lower.slice(0, -2);
	if (lower.endsWith('s') && !lower.endsWith('ss') && !lower.endsWith('us')) {
		return lower.slice(0, -1);
	}
	return lower;
};

const matches = (word: string, table: Table) => {
	const [schema, name] = word.includes('.') ? word.split('.', 2) : [undefined, word];
	if (schema !== undefined && schema.toLowerCase() !== table.schema.toLowerCase()) return false;
	return singular(name) === singular(table.name);
};

export const matchTables = (word: string, tables: Table[]) =>
	tables.filter((table) => matches(word, table));

const MIN_PREFIX = 3;

export const hintedTables = (hints: Hint[], tables: Table[]) => {
	const strengths = new Map<string, number>();
	const raise = (table: Table, strength: number) =>
		strengths.set(tableKey(table), Math.max(strengths.get(tableKey(table)) ?? 0, strength));
	for (const { word, kind } of hints) {
		if (kind === 'exact') {
			for (const table of matchTables(word, tables)) raise(table, 1);
		} else if (word.length >= MIN_PREFIX) {
			const prefix = word.toLowerCase();
			for (const table of tables) {
				if (singular(table.name).startsWith(prefix)) raise(table, 0.5);
			}
		}
	}
	return strengths;
};

const LEADING_WORD = /^([A-Za-z_][\w.]*)(?::\s*|\s+)(\S.*)$/;

export const parseScope = (value: string, tables: Table[]) => {
	const match = LEADING_WORD.exec(value);
	if (match && matchTables(match[1], tables).length > 0) {
		return { query: match[2], hint: { word: match[1], kind: 'exact' } satisfies Hint };
	}
	return { query: value, hint: undefined };
};
