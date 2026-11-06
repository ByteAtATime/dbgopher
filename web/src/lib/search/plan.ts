import type { Column } from '../protocol/bindings/Column';
import type { Index } from '../protocol/bindings/Index';
import type { Overview } from '../protocol/bindings/Overview';
import type { Table } from '../protocol/bindings/Table';
import type { Candidate } from './detect';

export type Access = 'primaryKey' | 'unique' | 'foreignKey' | 'index' | 'none';

export type Tier = 'A' | 'B' | 'C';

export type Target = {
	schema: string;
	table: string;
	column: string;
	comparison: 'equal' | 'lowerEqual';
	typeOid: number;
	value: string;
	candidate: Candidate;
	access: Access;
	scoped: boolean;
};

export type Coverage =
	| { kind: 'unindexed'; schema: string; table: string; columns: string[]; rowCount: number | null }
	| { kind: 'unreadable'; schema: string; table: string };

export type Plan = { targets: Target[]; coverage: Coverage[] };

export const SMALL_TABLE_ROWS = 50_000;

const OID = { int2: 21, int4: 23, int8: 20, numeric: 1700, text: 25, varchar: 1043, uuid: 2950 };
const INTEGER_MAX = new Map([
	[OID.int2, 32767n],
	[OID.int4, 2147483647n],
	[OID.int8, 9223372036854775807n]
]);
const ID_LIKE = /^(id|uuid|slug)$|_(id|uuid|key|ref|number)$|[a-z]Id$/;
const UUID_CHAR = /^character\((32|36)\)$/;
const CITEXT = /(^|\.)citext$/;
const LOWER = /^lower\(\(?(?:"((?:[^"]|"")+)"|([a-z_][a-z0-9_$]*))\)?(?:::text)?\)$/;

export const tier = (access: Access): Tier => {
	if (access === 'primaryKey' || access === 'unique') return 'A';
	return access === 'none' ? 'C' : 'B';
};

export const singular = (word: string) =>
	word
		.toLowerCase()
		.replace(/ies$/, 'y')
		.replace(/(s|x|z|ch|sh)es$/, '$1')
		.replace(/s$/, '');

const textual = (column: Column) =>
	column.typeOid === OID.text || column.typeOid === OID.varchar || CITEXT.test(column.typeName);

const usable = (table: Table) =>
	table.indexes.filter((index) => index.method === 'btree' && !index.partial);

const lowered = (index: Index) => {
	const [key] = index.keys;
	if (key.kind !== 'expression') return null;
	const match = LOWER.exec(key.definition);
	return match ? (match[1]?.replaceAll('""', '"') ?? match[2]) : null;
};

const accessVia = (table: Table, column: string, leading: Index[]): Access => {
	if (leading.length === 0) return 'none';
	if (leading.some((index) => index.unique && index.keys.length === 1)) return 'unique';
	return table.foreignKeys.some((key) => key.columns[0] === column) ? 'foreignKey' : 'index';
};

const columnAccess = (table: Table, column: string): Access => {
	if (table.primaryKey.length === 1 && table.primaryKey[0] === column) return 'primaryKey';
	const leading = usable(table).filter(
		({ keys: [key] }) => key.kind === 'column' && key.name === column
	);
	return accessVia(table, column, leading);
};

const lowerAccess = (table: Table, column: string): Access =>
	accessVia(
		table,
		column,
		usable(table).filter((index) => lowered(index) === column)
	);

const binding = (candidate: Candidate, column: Column, access: Access) => {
	const idLike = ID_LIKE.test(column.name);
	switch (candidate.kind) {
		case 'uuid': {
			if (column.typeOid === OID.uuid) return { typeOid: OID.uuid, value: candidate.value };
			const width = UUID_CHAR.exec(column.typeName)?.[1];
			if (width === '32' && idLike)
				return { typeOid: column.typeOid, value: candidate.value.replaceAll('-', '') };
			if ((width === '36' || textual(column)) && idLike)
				return { typeOid: column.typeOid, value: candidate.value };
			return null;
		}
		case 'integer': {
			const max = INTEGER_MAX.get(column.typeOid);
			if (max !== undefined)
				return candidate.value <= max
					? { typeOid: column.typeOid, value: candidate.value.toString() }
					: null;
			if (column.typeOid === OID.numeric || (textual(column) && idLike))
				return { typeOid: column.typeOid, value: candidate.value.toString() };
			return null;
		}
		case 'email':
			return textual(column) ? { typeOid: column.typeOid, value: candidate.value } : null;
		case 'text':
			return textual(column) && (idLike || tier(access) === 'A')
				? { typeOid: column.typeOid, value: candidate.value }
				: null;
	}
};

const tableTargets = (table: Table, candidates: Candidate[]) => {
	const small = table.rowCount !== null && table.rowCount < SMALL_TABLE_ROWS;
	const targets: Target[] = [];
	const skipped = new Set<string>();
	for (const column of table.columns) {
		const lowerVia = textual(column) ? lowerAccess(table, column.name) : 'none';
		const lower = lowerVia !== 'none';
		const access = lower ? lowerVia : columnAccess(table, column.name);
		for (const candidate of candidates) {
			const bound = binding(candidate, column, access);
			if (!bound) continue;
			if (access === 'none' && !small) {
				skipped.add(column.name);
				continue;
			}
			targets.push({
				schema: table.schema,
				table: table.name,
				column: column.name,
				comparison: lower ? 'lowerEqual' : 'equal',
				typeOid: lower ? OID.text : bound.typeOid,
				value: lower ? bound.value.toLowerCase() : bound.value,
				candidate,
				access,
				scoped: candidate.scope !== null && singular(candidate.scope) === singular(table.name)
			});
		}
	}
	const coverage: Coverage[] =
		skipped.size > 0
			? [
					{
						kind: 'unindexed',
						schema: table.schema,
						table: table.name,
						columns: [...skipped],
						rowCount: table.rowCount
					}
				]
			: [];
	return { targets, coverage };
};

const targetKey = (target: Target) =>
	[
		target.schema,
		target.table,
		target.column,
		target.comparison,
		target.typeOid,
		target.value
	].join('\0');

export const plan = (candidates: Candidate[], overview: Overview): Plan => {
	const searchable = overview.tables.filter(
		(table) => table.kind === 'table' || table.kind === 'partitionedTable'
	);
	const planned = searchable.map((table) => tableTargets(table, candidates));
	const pathRank = (schema: string) => {
		const position = overview.searchPath.indexOf(schema);
		return position === -1 ? overview.searchPath.length : position;
	};
	const unique = new Map<string, Target>();
	for (const target of planned.flatMap(({ targets }) => targets)) {
		if (!unique.has(targetKey(target))) unique.set(targetKey(target), target);
	}
	const targets = [...unique.values()].sort(
		(a, b) =>
			tier(a.access).localeCompare(tier(b.access)) ||
			pathRank(a.schema) - pathRank(b.schema) ||
			a.schema.localeCompare(b.schema) ||
			a.table.localeCompare(b.table)
	);
	return {
		targets,
		coverage: [
			...planned.flatMap(({ coverage }) => coverage),
			...overview.unreadableTables
				.filter((table) => table.kind === 'table' || table.kind === 'partitionedTable')
				.map((table): Coverage => ({ kind: 'unreadable', schema: table.schema, table: table.name }))
		]
	};
};
