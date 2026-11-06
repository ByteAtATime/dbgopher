import { describe, expect, it } from 'vitest';
import type { Column } from '../protocol/bindings/Column';
import type { PaletteTarget } from '../protocol/bindings/PaletteTarget';
import type { Palette } from '../protocol/client';
import type { Candidate } from './detect';
import { execute, failedTables, preview, rowFilter, tableLabel, type Found } from './execute';
import type { Target } from './plan';

const candidate: Candidate = {
	kind: 'integer',
	value: 42n,
	confidence: 'low',
	source: 'paste',
	scope: null
};

const target = (table: string, overrides: Partial<Target> = {}): Target => ({
	schema: 'public',
	table,
	column: 'id',
	comparison: 'equal',
	typeOid: 23,
	value: '42',
	candidate,
	access: 'primaryKey',
	scoped: false,
	...overrides
});

const column = (name: string): Column => ({
	name,
	typeOid: 25,
	typeName: 'text',
	nullable: false,
	hasDefault: false
});

const found = (values: Record<string, string | null>): Found => ({
	columns: Object.keys(values).map(column),
	values: Object.values(values).map((text) => (text === null ? null : { kind: 'text', text }))
});

describe('execute', () => {
	it('searches every target in one request and settles each outcome', async () => {
		const users = target('users');
		const orders = target('orders', { column: 'user_id', access: 'foreignKey' });
		const logs = target('logs', { column: 'ref', access: 'none' });
		const requests: PaletteTarget[][] = [];
		const results = await execute([users, orders, logs], async (targets): Promise<Palette> => {
			requests.push(targets);
			return {
				type: 'palette',
				outcomes: targets.map(({ table }) =>
					table === 'logs'
						? { kind: 'timedOut' }
						: { kind: 'rows', columns: [column('id')], rows: [[{ kind: 'text', text: '42' }]] }
				)
			};
		});
		expect(requests.map((batch) => batch.map(({ table }) => table))).toEqual([
			['users', 'orders', 'logs']
		]);
		expect(requests[0][0]).toEqual({
			schema: 'public',
			table: 'users',
			column: 'id',
			comparison: 'equal',
			value: '42'
		});
		expect(results.hits.map(({ target }) => target)).toEqual([users, orders, logs]);
		expect(results.hits[2]).toEqual({ target: logs, rows: [] });
		expect(results.failures).toEqual([{ target: logs, outcome: { kind: 'timedOut' } }]);
	});

	it('sends nothing when there are no targets', async () => {
		let sent = false;
		const results = await execute([], async () => {
			sent = true;
			return { type: 'palette', outcomes: [] };
		});
		expect(sent).toBe(false);
		expect(results).toEqual({ hits: [], failures: [] });
	});
});

describe('rowFilter', () => {
	it('filters by the primary key when the row has it', () => {
		const row = found({ tenant_id: '7', id: '42', email: 'a@b.co' });
		expect(rowFilter(['tenant_id', 'id'], target('users'), row)).toEqual([
			{ column: 'tenant_id', value: '7' },
			{ column: 'id', value: '42' }
		]);
	});

	it('falls back to the stored value of the matched column', () => {
		const email = target('users', { column: 'email', comparison: 'lowerEqual', value: 'a@b.co' });
		expect(rowFilter([], email, found({ email: 'A@B.co' }))).toEqual([
			{ column: 'email', value: 'A@B.co' }
		]);
		expect(rowFilter(['id'], email, found({ id: null, email: 'A@B.co' }))).toEqual([
			{ column: 'email', value: 'A@B.co' }
		]);
	});
});

describe('preview', () => {
	it('shows the key, the matched column, then display columns', () => {
		const row = found({ id: '1', secret: 'x', ref: 'r', name: 'Ada', status: 'ok', title: 't' });
		expect(
			preview(['id'], target('users', { column: 'ref' }), row).map(({ column }) => column)
		).toEqual(['id', 'ref', 'name', 'status']);
	});
});

describe('failedTables', () => {
	it('counts unreadable and failed tables once each, ignoring skipped ones', () => {
		expect(
			failedTables(
				[
					{ kind: 'unindexed', schema: 'public', table: 'big', columns: ['ref'], rowCount: 1e6 },
					{ kind: 'unreadable', schema: 'public', table: 'payroll' }
				],
				[target('logs'), target('logs', { column: 'ref' }), target('bad')]
			)
		).toBe(3);
	});
});

describe('tableLabel', () => {
	it('qualifies a table only when its name exists in another schema', () => {
		const tables = [
			{ schema: 'public', name: 'users' },
			{ schema: 'auth', name: 'users' },
			{ schema: 'public', name: 'orders' }
		];
		expect(tableLabel('auth', 'users', tables)).toBe('auth.users');
		expect(tableLabel('public', 'orders', tables)).toBe('orders');
	});
});
