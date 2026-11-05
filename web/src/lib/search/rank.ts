import type { Filter } from '../protocol/bindings/Filter';
import type { Table } from '../protocol/bindings/Table';
import type { Browse, ProbeOutcome } from '../protocol/client';
import { HIGH, type Candidate, type Detector } from './detect';
import type { Plan, PlannedProbe, Target } from './plan';
import { singular, tableKey } from './scope';

export type Value = Browse['rows'][number][number];

export type Reason = {
	target: Target;
	count: number;
	truncated: boolean;
	score: number;
};

export type Related = { table: Table; count: number; truncated: boolean };

export type Hit = {
	key: string;
	table: Table;
	columns: string[];
	cells: Value[];
	score: number;
	reasons: Reason[];
	filter: Filter[];
	identity: string | undefined;
	related: Related[];
};

export type Group = { table: Table; hits: Hit[]; score: number };

export type Failure = { table: Table; message: string };

export type Ranking = {
	groups: Group[];
	jump: Hit | undefined;
	weak: { tables: number; example: string } | undefined;
	timedOut: number;
	denied: number;
	failed: Failure[];
	pending: number;
	done: boolean;
};

export type RankInput = {
	plan: Plan;
	outcomes: (ProbeOutcome | undefined)[];
	hints: ReadonlyMap<string, number>;
	history: (table: string, detector: Detector) => number;
	query: string;
	searchPath: string[];
};

const WEIGHT = { type: 1, column: 1, name: 0.4, scope: 1, history: 0.5, fanout: 0.5, fuzzy: 2 };
const ROWS_FOR_MANY = 6;
const WEAK_TABLES = 5;
const STRONG_SCORE = 2.2;
const ID_KINDS = new Set<Candidate['kind']>(['integer', 'uuid', 'text']);

const nameHint = (column: string, kind: Candidate['kind']) => {
	const name = column.toLowerCase();
	switch (kind) {
		case 'email':
			return /^(e_?)?mail(_?address)?$/.test(name) ? 1 : name.includes('mail') ? 0.5 : 0;
		case 'phone':
			return /phone|mobile|tel|msisdn/.test(name) ? 1 : 0;
		case 'ip':
			return /(^|_)ip(_|$)|addr/.test(name) ? 1 : 0;
		case 'timestamp':
			return /_(at|on)$|date|time/.test(name) ? 0.5 : 0;
		default:
			return name === 'id'
				? 1
				: /(^|_)(id|uuid|guid|slug)$|^external_?id$/.test(name)
					? 0.7
					: /(^|_)(key|ref|code|token|number|no|identifier|handle)$/.test(name)
						? 0.5
						: 0;
	}
};

const text = (value: Value | undefined) => (value?.kind === 'text' ? value.text : undefined);

const identify = (table: Table, columns: string[], cells: Value[]) => {
	const values = table.primaryKey.map((name) => text(cells[columns.indexOf(name)]));
	if (table.primaryKey.length === 0 || values.some((value) => value === undefined)) {
		return undefined;
	}
	return table.primaryKey.map((column, index) => ({ column, value: values[index] ?? '' }));
};

const sameCandidate = (a: Candidate, b: Candidate) => a.kind === b.kind && a.value === b.value;

export const rank = ({ plan, outcomes, hints, history, query, searchPath }: RankInput): Ranking => {
	const hits = new Map<string, Hit>();
	let timedOut = 0;
	let denied = 0;
	const failed: Failure[] = [];

	const score = (probe: PlannedProbe, target: Target, count: number) =>
		WEIGHT.type * target.candidate.confidence +
		WEIGHT.column * target.strength +
		WEIGHT.name * nameHint(target.column, target.candidate.kind) +
		WEIGHT.scope * (hints.get(tableKey(probe.table)) ?? 0) +
		WEIGHT.history * history(tableKey(probe.table), target.candidate.detector) -
		(WEIGHT.fanout * Math.min(count - 1, ROWS_FOR_MANY - 1)) / (ROWS_FOR_MANY - 1) -
		(target.fuzzy ? WEIGHT.fuzzy : 0);

	plan.probes.forEach((probe, index) => {
		const outcome = outcomes[index];
		if (!outcome) return;
		if (outcome.type === 'timedOut') timedOut += 1;
		if (outcome.type === 'denied') denied += 1;
		if (outcome.type === 'failed') failed.push({ table: probe.table, message: outcome.message });
		if (outcome.type !== 'rows') return;
		const truncated = outcome.hits.length >= outcome.limit;
		const counts = probe.targets.map(
			(_, position) => outcome.hits.filter((hit) => hit.matched[position]).length
		);
		for (const { cells, matched } of outcome.hits) {
			const identity = identify(probe.table, outcome.columns, cells);
			const key = `${tableKey(probe.table)}\0${identity ? JSON.stringify(identity) : JSON.stringify(cells)}`;
			const hit = hits.get(key) ?? {
				key,
				table: probe.table,
				columns: outcome.columns,
				cells,
				score: -Infinity,
				reasons: [],
				filter: identity ?? [],
				identity: identity?.map(({ value }) => value).join(', '),
				related: []
			};
			matched.forEach((isMatch, position) => {
				const target = probe.targets[position];
				if (!isMatch || !target) return;
				const count = truncated ? Math.max(counts[position], ROWS_FOR_MANY) : counts[position];
				const reason = {
					target,
					count,
					truncated: truncated || counts[position] >= ROWS_FOR_MANY,
					score: score(probe, target, count)
				};
				hit.reasons.push(reason);
				hit.score = Math.max(hit.score, reason.score);
			});
			if (hit.reasons.length === 0) continue;
			hit.reasons.sort((a, b) => b.score - a.score);
			if (!identity) {
				const column = hit.reasons[0].target.filterColumn;
				const value =
					column === undefined ? undefined : text(cells[outcome.columns.indexOf(column)]);
				hit.filter = column !== undefined && value !== undefined ? [{ column, value }] : [];
			}
			hits.set(key, hit);
		}
	});

	const all = [...hits.values()];
	for (const hit of all) {
		const reason = hit.reasons[0];
		const references = reason.target.references;
		if (!references || reason.target.tier === 'A') continue;
		const parent = all.find(
			(other) =>
				other !== hit &&
				other.table.schema === references.schema &&
				other.table.name === references.table &&
				other.reasons.some(
					({ target }) =>
						target.column === references.column &&
						sameCandidate(target.candidate, reason.target.candidate)
				)
		);
		if (!parent) continue;
		const existing = parent.related.find(({ table }) => table === hit.table);
		if (existing) {
			existing.count += 1;
			existing.truncated ||= reason.truncated;
		} else {
			parent.related.push({ table: hit.table, count: 1, truncated: reason.truncated });
		}
		hits.delete(hit.key);
	}

	const schemaOrder = (table: Table) => {
		const position = searchPath.indexOf(table.schema);
		return position === -1 ? searchPath.length : position;
	};
	const groups = new Map<string, Group>();
	for (const hit of hits.values()) {
		const key = tableKey(hit.table);
		const group = groups.get(key) ?? { table: hit.table, hits: [], score: -Infinity };
		group.hits.push(hit);
		group.score = Math.max(group.score, hit.score);
		groups.set(key, group);
	}
	const sorted = [...groups.values()]
		.map((group) => ({ ...group, hits: group.hits.toSorted((a, b) => b.score - a.score) }))
		.toSorted(
			(a, b) =>
				b.score - a.score ||
				schemaOrder(a.table) - schemaOrder(b.table) ||
				tableKey(a.table).localeCompare(tableKey(b.table))
		);

	const pending = outcomes.filter((outcome) => outcome === undefined).length;
	const tierADone = plan.probes.every(
		(probe, index) => probe.tier !== 'A' || outcomes[index]?.type === 'rows'
	);
	const strongHits = [...hits.values()].filter((hit) =>
		hit.reasons.some(({ target }) => target.tier === 'A' && !target.fuzzy)
	);
	const top = sorted[0]?.hits[0];
	const jumpable =
		tierADone && strongHits.length === 1 && top === strongHits[0] && top.filter.length > 0;
	const strongReason = top?.reasons.find(({ target }) => target.tier === 'A');
	const jump =
		jumpable &&
		strongReason &&
		!strongReason.target.partialKey &&
		(strongReason.target.candidate.confidence >= HIGH || (hints.get(tableKey(top.table)) ?? 0) >= 1)
			? top
			: undefined;

	const done = pending === 0;
	const hinted = [...hints.values()].some((strength) => strength >= 1);
	const weak =
		done &&
		!jump &&
		!hinted &&
		top &&
		sorted.length >= WEAK_TABLES &&
		top.score < STRONG_SCORE &&
		ID_KINDS.has(top.reasons[0].target.candidate.kind)
			? { tables: sorted.length, example: `${singular(top.table.name)} ${query}` }
			: undefined;

	return { groups: sorted, jump, weak, timedOut, denied, failed, pending, done };
};
