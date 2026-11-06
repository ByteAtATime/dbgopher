import type { Candidate, Confidence } from './detect';
import { tier, type Access, type Target } from './plan';

export type Hit<Row> = { target: Target; rows: Row[] };

export type Ranked<Row> = Hit<Row> & { score: number };

export type Group<Row> = { schema: string; table: string; score: number; hits: Ranked<Row>[] };

export type Decision<Row> =
	| { kind: 'jump'; hit: Ranked<Row>; groups: Group<Row>[] }
	| { kind: 'results'; groups: Group<Row>[]; pending: number; needsHint: boolean }
	| { kind: 'none' };

export const WEIGHTS = { confidence: 1, access: 1, name: 0.5, scope: 1, fanout: 0.5 };
export const AMBIGUOUS_TABLES = 5;

const CONFIDENCE: Record<Confidence, number> = { high: 1, medium: 0.6, low: 0.3 };
const ACCESS: Record<Access, number> = {
	primaryKey: 1,
	unique: 0.9,
	index: 0.6,
	foreignKey: 0.5,
	none: 0.3
};
const NAME_HINTS: Record<Candidate['kind'], RegExp> = {
	uuid: /(^|_)(id|uuid)$|[a-z]Id$/,
	integer: /(^|_)(id|number)$|[a-z]Id$/,
	email: /e-?mail/i,
	text: /(^|_)(id|uuid|slug|key|code|ref)$|[a-z]Id$/
};
const FANOUT_LIMIT = 6;

const strong = ({ access, candidate, scoped }: Target) =>
	tier(access) === 'A' && (candidate.confidence === 'high' || scoped);

export const score = ({ target, rows }: Hit<unknown>) =>
	WEIGHTS.confidence * CONFIDENCE[target.candidate.confidence] +
	WEIGHTS.access * ACCESS[target.access] +
	WEIGHTS.name * (NAME_HINTS[target.candidate.kind].test(target.column) ? 1 : 0) +
	WEIGHTS.scope * (target.scoped ? 1 : 0) -
	WEIGHTS.fanout * (Math.max(Math.min(rows.length, FANOUT_LIMIT) - 1, 0) / (FANOUT_LIMIT - 1));

const group = <Row>(ranked: Ranked<Row>[]) => {
	const groups = new Map<string, Group<Row>>();
	for (const hit of ranked) {
		const key = `${hit.target.schema}\0${hit.target.table}`;
		const existing = groups.get(key);
		if (existing) existing.hits.push(hit);
		else
			groups.set(key, {
				schema: hit.target.schema,
				table: hit.target.table,
				score: hit.score,
				hits: [hit]
			});
	}
	return [...groups.values()];
};

export const decide = <Row>(targets: Target[], hits: Hit<Row>[]): Decision<Row> => {
	const reported = new Set(hits.map(({ target }) => target));
	const pending = targets.filter((target) => !reported.has(target));
	const ranked = hits
		.filter(({ rows }) => rows.length > 0)
		.map((hit) => ({ ...hit, score: score(hit) }))
		.sort((a, b) => b.score - a.score || targets.indexOf(a.target) - targets.indexOf(b.target));
	if (ranked.length === 0 && pending.length === 0) return { kind: 'none' };

	const [top] = ranked;
	const tierA = ranked.filter(({ target }) => tier(target.access) === 'A');
	const tierAComplete = pending.every(({ access }) => tier(access) !== 'A');
	const singleTierARow = tierA.length === 1 && tierA[0].rows.length === 1;
	const groups = group(ranked);
	if (top && strong(top.target) && singleTierARow && tierA[0] === top && tierAComplete)
		return { kind: 'jump', hit: top, groups };

	const needsHint =
		groups.length >= AMBIGUOUS_TABLES &&
		!ranked.some(({ target }) => strong(target) || target.scoped);
	return { kind: 'results', groups, pending: pending.length, needsHint };
};
