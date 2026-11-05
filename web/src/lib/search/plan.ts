import type { Column } from '../protocol/bindings/Column';
import type { Condition } from '../protocol/bindings/Condition';
import type { Probe } from '../protocol/bindings/Probe';
import type { Table } from '../protocol/bindings/Table';
import type { Overview } from '../protocol/client';
import type { Candidate, Span } from './detect';
import { tableKey } from './scope';

export type Tier = 'A' | 'B' | 'C';

export type Reference = { schema: string; table: string; column: string };

export type Target = {
	column: string;
	filterColumn?: string;
	candidate: Candidate;
	tier: Tier;
	strength: number;
	partialKey: boolean;
	caseInsensitive: boolean;
	fuzzy: boolean;
	references?: Reference;
};

export type PlannedProbe = {
	tier: Tier;
	table: Table;
	probe: Probe;
	targets: Target[];
};

export type Skipped = { table: Table; columns: string[] };

export type Plan = {
	probes: PlannedProbe[];
	searched: { columns: number; tables: number };
	skipped: Skipped[];
	extrasSkipped: number;
	restricted: number;
	rowSecurity: number;
	insensitive: boolean;
};

export type PlanOptions = {
	optIns: readonly string[];
	insensitive: boolean;
	timeZone: string;
};

export const SMALL_TABLE_ROWS = 50_000;

const STRENGTH = { primary: 1, unique: 0.9, indexed: 0.6, foreignKey: 0.5, unindexed: 0.3 };
const MIN_TRIGRAM_LENGTH = 3;

const OID = {
	int2: 21,
	int4: 23,
	int8: 20,
	numeric: 1700,
	text: 25,
	varchar: 1043,
	bpchar: 1042,
	uuid: 2950,
	timestamp: 1114,
	timestamptz: 1184,
	date: 1082,
	inet: 869,
	cidr: 650,
	jsonb: 3802
} as const;

const INTEGER_MAX = new Map<number, bigint>([
	[OID.int2, 32767n],
	[OID.int4, 2147483647n],
	[OID.int8, 9223372036854775807n]
]);

const TIME_TYPES = new Set<number>([OID.timestamp, OID.timestamptz, OID.date]);
const TEXT_TYPES = new Set<number>([OID.text, OID.varchar, OID.bpchar]);
const TRIGRAM_CLASSES = new Set(['gin_trgm_ops', 'gist_trgm_ops']);
const JSON_CLASSES = new Set(['jsonb_ops', 'jsonb_path_ops']);
const EQUALITY_METHODS = new Set(['btree', 'hash']);

const ID_NAME = /(^|_)(id|uuid|guid|key|ref|code|slug|token|number|no|identifier|handle)$/i;
const PHONE_NAME = /phone|mobile|tel|msisdn|fax/i;
const JSON_PATH = /->>|#>>/;
const LOWER = /^lower\(\(?("(?:[^"]|"")+"|[^()":\s]+)\)?(?:::[\w ]+)?\)$/;

const isCitext = (column: Column) =>
	column.typeName === 'citext' || column.typeName.endsWith('.citext');
const isText = (column: Column) => TEXT_TYPES.has(column.typeOid) || isCitext(column);
const fixedLength = (column: Column) =>
	column.typeOid === OID.bpchar ? Number(/\((\d+)\)/.exec(column.typeName)?.[1] ?? '1') : undefined;

const unquote = (identifier: string) =>
	identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier;

type Slot = { tier: Tier; strength: number };

type Profile = Slot & {
	partialKey: boolean;
	ordered: boolean;
	unique: boolean;
	references?: Reference;
	lower?: Slot & { index: string };
	trigram: boolean;
	json: boolean;
};

type Expression = Slot & { index: string; expression: string };

const indexSlot = (unique: boolean, keyCount: number): Slot =>
	unique && keyCount === 1
		? { tier: 'A', strength: STRENGTH.unique }
		: { tier: 'B', strength: STRENGTH.indexed };

const profile = (table: Table) => {
	const usable = table.indexes.filter((index) => !index.partial);
	const columns = new Map<string, Profile>();
	for (const column of table.columns) {
		const leading = usable.filter(
			(index) => index.column === column.name && EQUALITY_METHODS.has(index.method)
		);
		const foreignKey = table.foreignKeys.find(
			(key) => key.columns.length === 1 && key.columns[0] === column.name
		);
		const primary = table.primaryKey.length === 1 && table.primaryKey[0] === column.name;
		const unique = leading.some((index) => index.unique && index.keyCount === 1);
		const slot: Slot = primary
			? { tier: 'A', strength: STRENGTH.primary }
			: unique
				? { tier: 'A', strength: STRENGTH.unique }
				: leading.length > 0
					? { tier: 'B', strength: foreignKey ? STRENGTH.foreignKey : STRENGTH.indexed }
					: { tier: 'C', strength: STRENGTH.unindexed };
		const lower = usable.find((index) => {
			const match = index.expression && LOWER.exec(index.expression);
			return match && unquote(match[1]) === column.name && EQUALITY_METHODS.has(index.method);
		});
		columns.set(column.name, {
			...slot,
			partialKey: table.primaryKey.length > 1 && table.primaryKey.includes(column.name),
			ordered: primary || leading.some((index) => index.method === 'btree'),
			unique: primary || unique,
			references: foreignKey && {
				schema: foreignKey.referencedSchema,
				table: foreignKey.referencedTable,
				column: foreignKey.referencedColumns[0]
			},
			lower: lower && { index: lower.name, ...indexSlot(lower.unique, lower.keyCount) },
			trigram: usable.some(
				(index) => index.column === column.name && TRIGRAM_CLASSES.has(index.operatorClass)
			),
			json:
				column.typeOid === OID.jsonb &&
				usable.some(
					(index) =>
						index.column === column.name &&
						index.method === 'gin' &&
						JSON_CLASSES.has(index.operatorClass)
				)
		});
	}
	const expressions: Expression[] = usable
		.filter(
			(index) =>
				index.expression !== null &&
				JSON_PATH.test(index.expression) &&
				index.expressionType === 'text' &&
				EQUALITY_METHODS.has(index.method)
		)
		.map((index) => ({
			index: index.name,
			expression: index.expression ?? '',
			...indexSlot(index.unique, index.keyCount)
		}));
	return { columns, expressions };
};

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

const nextDay = (date: string) => {
	const [year, month, day] = date.split('-').map(Number);
	const next = new Date(Date.UTC(year, month - 1, day + 1));
	return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
};

const bounds = (span: Span, column: Column, timeZone: string) => {
	if (column.typeOid === OID.date) {
		const from = span.from.slice(0, 10);
		return { from, to: span.unit === 'day' ? span.to.slice(0, 10) : nextDay(from) };
	}
	if (column.typeOid === OID.timestamptz) {
		const zone = span.zone ?? timeZone;
		return { from: `${span.from} ${zone}`, to: `${span.to} ${zone}` };
	}
	return { from: span.from, to: span.to };
};

type Planned = {
	condition: Condition;
	slot: Slot;
	caseInsensitive?: boolean;
	unbounded?: boolean;
};

const equal = (column: Column, value: string): Condition => ({
	type: 'equal',
	column: column.name,
	value
});

const textValues = (column: Column, texts: string[]) => {
	const length = fixedLength(column);
	return length === 32 || length === 36 ? texts.filter((text) => text.length === length) : texts;
};

const exact = (
	candidate: Candidate,
	column: Column,
	profile: Profile,
	options: PlanOptions
): { planned: Planned[]; exactOnly: boolean } => {
	const slot: Slot = profile;
	const each = (values: string[]) =>
		values.map((value) => ({ condition: equal(column, value), slot }));
	switch (candidate.kind) {
		case 'uuid':
			if (column.typeOid === OID.uuid)
				return { planned: each([candidate.value]), exactOnly: false };
			if (
				isText(column) &&
				(ID_NAME.test(column.name) || [32, 36].includes(fixedLength(column) ?? 0))
			) {
				return { planned: each(textValues(column, candidate.texts)), exactOnly: false };
			}
			break;
		case 'integer': {
			const max = INTEGER_MAX.get(column.typeOid);
			if (max !== undefined) {
				return {
					planned: BigInt(candidate.value) <= max ? each([candidate.value]) : [],
					exactOnly: false
				};
			}
			if (column.typeOid === OID.numeric || (isText(column) && ID_NAME.test(column.name))) {
				return { planned: each([candidate.value]), exactOnly: false };
			}
			break;
		}
		case 'email':
			if (!isText(column)) break;
			if (isCitext(column)) return { planned: each([candidate.value]), exactOnly: false };
			if (profile.lower) {
				return {
					planned: [
						{
							condition: {
								type: 'index',
								index: profile.lower.index,
								value: candidate.value.toLowerCase()
							},
							slot: profile.lower,
							caseInsensitive: true
						}
					],
					exactOnly: false
				};
			}
			return {
				planned: [
					...each(candidate.texts),
					...(options.insensitive
						? [
								{
									condition: {
										type: 'insensitive',
										column: column.name,
										value: candidate.value
									} satisfies Condition,
									slot: { tier: 'C', strength: STRENGTH.unindexed } satisfies Slot,
									caseInsensitive: true,
									unbounded: true
								}
							]
						: [])
				],
				exactOnly: true
			};
		case 'text':
			if (isText(column) && (profile.unique || ID_NAME.test(column.name))) {
				return { planned: each(candidate.texts), exactOnly: false };
			}
			break;
		case 'phone':
			if (isText(column) && (profile.unique || PHONE_NAME.test(column.name))) {
				return { planned: each(candidate.texts), exactOnly: false };
			}
			break;
		case 'timestamp':
			if (TIME_TYPES.has(column.typeOid)) {
				const { from, to } = bounds(candidate.span, column, options.timeZone);
				return {
					planned: [
						{
							condition: { type: 'range', column: column.name, from, to },
							slot: profile.ordered ? slot : { tier: 'C', strength: STRENGTH.unindexed }
						}
					],
					exactOnly: false
				};
			}
			break;
		case 'ip':
			if (column.typeOid === OID.inet || column.typeOid === OID.cidr) {
				return { planned: each([candidate.value]), exactOnly: false };
			}
			break;
	}
	return { planned: [], exactOnly: false };
};

const STRINGISH = new Set<Candidate['kind']>(['uuid', 'email', 'text', 'integer']);

const extras = (candidate: Candidate, column: Column, profile: Profile): Condition[] => {
	const conditions: Condition[] = [];
	if (
		profile.trigram &&
		(candidate.kind === 'text' || candidate.kind === 'email') &&
		candidate.value.length >= MIN_TRIGRAM_LENGTH
	) {
		conditions.push({ type: 'trigram', column: column.name, value: candidate.value });
	}
	if (profile.json && STRINGISH.has(candidate.kind)) {
		conditions.push({
			type: 'json',
			column: column.name,
			value: candidate.value,
			number: candidate.kind === 'integer'
		});
	}
	return conditions;
};

const SEARCHABLE = new Set<Table['kind']>(['table', 'partitionedTable']);

type Group = { conditions: Condition[]; targets: Target[]; seen: Set<string> };

const group = (): Group => ({ conditions: [], targets: [], seen: new Set() });

const push = (into: Group, condition: Condition, target: Target) => {
	const key = JSON.stringify(condition);
	if (into.seen.has(key)) return;
	into.seen.add(key);
	into.conditions.push(condition);
	into.targets.push(target);
};

export const plan = (overview: Overview, candidates: Candidate[], options: PlanOptions): Plan => {
	const order = (table: Table) => {
		const position = overview.searchPath.indexOf(table.schema);
		return position === -1 ? overview.searchPath.length : position;
	};
	const tables = overview.tables
		.filter((table) => SEARCHABLE.has(table.kind))
		.toSorted((a, b) => order(a) - order(b));
	const probes: PlannedProbe[] = [];
	const skipped: Skipped[] = [];
	let extrasSkipped = 0;
	let insensitive = false;

	for (const table of tables) {
		const small = table.rowCount !== null && table.rowCount < SMALL_TABLE_ROWS;
		const bounded = small || options.optIns.includes(tableKey(table));
		const { columns, expressions } = profile(table);
		const groups = { A: group(), B: group(), C: group(), X: group() };
		const skippedColumns = new Set<string>();
		let skippedExtras = false;

		const target = (column: string, candidate: Candidate, slot: Slot, profile?: Profile) => ({
			column,
			candidate,
			tier: slot.tier,
			strength: slot.strength,
			partialKey: profile?.partialKey ?? false,
			caseInsensitive: false,
			fuzzy: false,
			references: profile?.references
		});

		for (const candidate of candidates) {
			for (const column of table.columns) {
				const columnProfile = columns.get(column.name);
				if (!columnProfile) continue;
				const { planned, exactOnly } = exact(candidate, column, columnProfile, options);
				if (exactOnly && planned.length > 0 && !options.insensitive) insensitive = true;
				for (const { condition, slot, caseInsensitive, unbounded } of planned) {
					if (slot.tier === 'C' && !bounded && !unbounded) {
						skippedColumns.add(column.name);
						continue;
					}
					push(groups[slot.tier], condition, {
						...target(column.name, candidate, slot, columnProfile),
						filterColumn: condition.type === 'index' ? undefined : column.name,
						caseInsensitive: caseInsensitive ?? false
					});
				}
				for (const condition of extras(candidate, column, columnProfile)) {
					if (!small) {
						skippedExtras = true;
						continue;
					}
					push(groups.X, condition, {
						...target(column.name, candidate, { tier: 'C', strength: STRENGTH.unindexed }),
						filterColumn: column.name,
						fuzzy: condition.type === 'trigram'
					});
				}
			}
			if (!STRINGISH.has(candidate.kind)) continue;
			for (const expression of expressions) {
				if (!small) {
					skippedExtras = true;
					continue;
				}
				push(
					groups.X,
					{ type: 'index', index: expression.index, value: candidate.value },
					target(expression.expression, candidate, expression)
				);
			}
		}

		for (const tier of ['A', 'B', 'C', 'X'] as const) {
			const { conditions, targets } = groups[tier];
			if (conditions.length === 0) continue;
			probes.push({
				tier: tier === 'X' ? 'C' : tier,
				table,
				probe: { schema: table.schema, table: table.name, conditions },
				targets
			});
		}
		if (skippedColumns.size > 0) skipped.push({ table, columns: [...skippedColumns] });
		if (skippedExtras) extrasSkipped += 1;
	}

	const searchedTables = new Set(probes.map(({ table }) => tableKey(table)));
	const searchedColumns = new Set(
		probes.flatMap(({ table, targets }) =>
			targets.map(({ column }) => `${tableKey(table)}\0${column}`)
		)
	);
	return {
		probes,
		searched: { columns: searchedColumns.size, tables: searchedTables.size },
		skipped,
		extrasSkipped,
		restricted: overview.restricted.length,
		rowSecurity: tables.filter((table) => table.rowSecurity && searchedTables.has(tableKey(table)))
			.length,
		insensitive
	};
};
