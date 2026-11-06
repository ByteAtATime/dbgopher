import { describe, expect, it } from 'vitest';
import type { Candidate, Match } from './detect';
import type { Target } from './plan';
import { AMBIGUOUS_TABLES, decide, score, type Hit } from './rank';

const candidate = (
	match: Match = { kind: 'integer', value: 42n, confidence: 'low' }
): Candidate => ({ ...match, source: 'paste', scope: null });

const target = (table: string, overrides: Partial<Target> = {}): Target => ({
	schema: 'public',
	table,
	column: 'id',
	comparison: 'equal',
	typeOid: 23,
	value: '42',
	candidate: candidate(),
	access: 'primaryKey',
	scoped: false,
	...overrides
});

const uuid = candidate({ kind: 'uuid', value: '0', confidence: 'high' });

const hit = (target: Target, count = 1): Hit<number> => ({
	target,
	rows: Array.from({ length: count }, (_, i) => i)
});

describe('score', () => {
	it('prefers stronger detectors, keys, name hints and scope', () => {
		const base = score(hit(target('a')));
		expect(score(hit(target('a', { candidate: uuid })))).toBeGreaterThan(base);
		expect(score(hit(target('a', { access: 'index' })))).toBeLessThan(base);
		expect(score(hit(target('a', { column: 'code' })))).toBeLessThan(base);
		expect(score(hit(target('a', { scoped: true })))).toBeGreaterThan(base);
	});

	it('penalizes columns that return many rows', () => {
		expect(score(hit(target('a'), 6))).toBeLessThan(score(hit(target('a'), 2)));
		expect(score(hit(target('a'), 2))).toBeLessThan(score(hit(target('a'), 1)));
		expect(score(hit(target('a'), 60))).toBe(score(hit(target('a'), 6)));
	});
});

describe('decide', () => {
	it('jumps to the only tier A row from a high-confidence detector', () => {
		const users = target('users', { candidate: uuid });
		const orders = target('orders', { candidate: uuid, access: 'none' });
		expect(decide([users, orders], [hit(users)])).toEqual({
			kind: 'jump',
			hit: { ...hit(users), score: expect.any(Number) },
			groups: [
				{
					schema: 'public',
					table: 'users',
					score: expect.any(Number),
					hits: [{ ...hit(users), score: expect.any(Number) }]
				}
			]
		});
	});

	it('jumps on a low-confidence detector when the table was scoped', () => {
		const orders = target('orders', { scoped: true });
		const users = target('users');
		expect(decide([orders, users], [hit(orders), hit(users, 0)])).toMatchObject({ kind: 'jump' });
	});

	it('waits for every tier A target before jumping', () => {
		const users = target('users', { candidate: uuid });
		const accounts = target('accounts', { candidate: uuid });
		expect(decide([users, accounts], [hit(users)])).toMatchObject({ kind: 'results', pending: 1 });
	});

	it('does not jump when two tables match', () => {
		const users = target('users', { candidate: uuid });
		const accounts = target('accounts', { candidate: uuid });
		expect(decide([users, accounts], [hit(users), hit(accounts)])).toMatchObject({
			kind: 'results',
			pending: 0
		});
	});

	it('does not jump on a bare integer', () => {
		const orders = target('orders');
		expect(decide([orders], [hit(orders)])).toMatchObject({ kind: 'results' });
	});

	it('does not jump on a non-unique index', () => {
		const events = target('events', { candidate: uuid, access: 'index' });
		expect(decide([events], [hit(events)])).toMatchObject({ kind: 'results' });
	});

	it('groups hits by table, best table first', () => {
		const customers = target('customers', { column: 'email', candidate: uuid, access: 'none' });
		const ordersByCustomer = target('orders', { column: 'customer_id', access: 'foreignKey' });
		const ordersById = target('orders', { candidate: uuid });
		const targets = [ordersById, customers, ordersByCustomer];
		const result = decide(targets, [hit(customers), hit(ordersByCustomer, 3), hit(ordersById, 2)]);
		if (result.kind !== 'results') throw new Error(result.kind);
		expect(
			result.groups.map(({ table, hits }) => [table, hits.map(({ target }) => target.column)])
		).toEqual([
			['orders', ['id', 'customer_id']],
			['customers', ['email']]
		]);
	});

	it('asks for a hint when weak hits span many tables', () => {
		const targets = Array.from({ length: AMBIGUOUS_TABLES }, (_, i) => target(`t${i}`));
		expect(
			decide(
				targets,
				targets.map((t) => hit(t))
			)
		).toMatchObject({ kind: 'results', needsHint: true });
		expect(
			decide(
				targets.slice(1),
				targets.slice(1).map((t) => hit(t))
			)
		).toMatchObject({ kind: 'results', needsHint: false });
	});

	it('reports no hits only once every target has finished', () => {
		const users = target('users');
		const orders = target('orders');
		expect(decide([users, orders], [hit(users, 0)])).toEqual({
			kind: 'results',
			groups: [],
			pending: 1,
			needsHint: false
		});
		expect(decide([users, orders], [hit(users, 0), hit(orders, 0)])).toEqual({ kind: 'none' });
	});
});
