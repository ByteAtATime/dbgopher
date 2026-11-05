import { describe, expect, it } from 'vitest';
import type { Column } from '../protocol/bindings/Column';
import type { Index } from '../protocol/bindings/Index';
import type { Table } from '../protocol/bindings/Table';
import type { Overview, ProbeOutcome } from '../protocol/client';
import { analyze } from './analyze';
import { detect, select, type Candidate } from './detect';
import { normalize } from './normalize';
import type { Plan } from './plan';
import { rank } from './rank';
import { parseScope, singular } from './scope';

const column = (name: string, typeName: string, typeOid: number): Column => ({
	name,
	typeName,
	typeOid,
	nullable: false,
	hasDefault: false
});

const int4 = (name: string) => column(name, 'integer', 23);
const int8 = (name: string) => column(name, 'bigint', 20);
const text = (name: string) => column(name, 'text', 25);
const uuid = (name: string) => column(name, 'uuid', 2950);
const citext = (name: string) => column(name, 'citext', 91234);
const timestamptz = (name: string) => column(name, 'timestamp with time zone', 1184);

const index = (name: string, overrides: Partial<Index> = {}): Index => ({
	name,
	method: 'btree',
	unique: false,
	partial: false,
	keyCount: 1,
	column: null,
	expression: null,
	expressionType: null,
	operatorClass: 'default_ops',
	...overrides
});

const table = (name: string, columns: Column[], overrides: Partial<Table> = {}): Table => ({
	schema: 'public',
	name,
	kind: 'table',
	rowCount: 100,
	rowCountExact: true,
	totalBytes: 0,
	columns,
	primaryKey: [],
	foreignKeys: [],
	indexes: [],
	rowSecurity: false,
	...overrides
});

const withPrimaryKey = (name: string, columns: Column[], overrides: Partial<Table> = {}) =>
	table(name, columns, {
		primaryKey: [columns[0].name],
		indexes: [index(`${name}_pkey`, { unique: true, column: columns[0].name })],
		...overrides
	});

const overview = (tables: Table[], overrides: Partial<Overview> = {}): Overview => ({
	type: 'overview',
	tables,
	searchPath: ['public'],
	restricted: [],
	fingerprint: 'fingerprint',
	...overrides
});

const OPTIONS = { optIns: [], insensitive: false, timeZone: 'UTC' };

const conditionsFor = (plan: Plan, name: string) =>
	plan.probes
		.filter((probe) => probe.table.name === name)
		.flatMap((probe) => probe.probe.conditions);

const tiersFor = (plan: Plan, name: string) =>
	plan.probes.filter((probe) => probe.table.name === name).map((probe) => probe.tier);

const candidates = (value: string) => select(detect(value, value, false), null).candidates;

const kinds = (value: string) =>
	candidates(value).map((candidate: Candidate) => [candidate.kind, candidate.value]);

describe('normalize', () => {
	it('unwraps formatting pasted from chat', () => {
		expect(normalize('`ord_123`').value).toBe('ord_123');
		expect(normalize('"ord_123".').value).toBe('ord_123');
		expect(normalize('\u201Cord_123\u201D,').value).toBe('ord_123');
		expect(normalize('(ord_123)').value).toBe('ord_123');
		expect(normalize('ord_123)').value).toBe('ord_123');
	});

	it('strips zero-width characters and non-breaking spaces', () => {
		expect(normalize('\u00A01234\u200B ').value).toBe('1234');
		expect(normalize('12\u200B34').value).toBe('1234');
	});

	it('keeps the raw text and uses only the first line', () => {
		expect(normalize(' "ord_1"\nord_2\n\nord_3')).toEqual({
			raw: ' "ord_1"',
			value: 'ord_1',
			multiline: true
		});
		expect(normalize('ord_1\n').multiline).toBe(false);
	});

	it('keeps balanced parentheses inside the value', () => {
		expect(normalize('https://en.wikipedia.org/wiki/Foo_(bar)').value).toBe(
			'https://en.wikipedia.org/wiki/Foo_(bar)'
		);
	});
});

describe('detect', () => {
	it('canonicalizes UUIDs in any form', () => {
		for (const input of [
			'550E8400E29B41D4A716446655440000',
			'{550e8400-e29b-41d4-a716-446655440000}',
			'urn:uuid:550E8400-E29B-41D4-A716-446655440000'
		]) {
			expect(kinds(input)).toEqual([['uuid', '550e8400-e29b-41d4-a716-446655440000']]);
		}
	});

	it('extracts emails from mailto links and display names', () => {
		expect(kinds('mailto:Jane@Acme.com')).toEqual([['email', 'Jane@Acme.com']]);
		expect(kinds('Jane Doe <jane@acme.com>')).toEqual([['email', 'jane@acme.com']]);
		const [candidate] = candidates('Jane@Acme.com');
		expect(candidate.kind === 'email' && candidate.texts).toEqual([
			'Jane@Acme.com',
			'jane@acme.com'
		]);
	});

	it('splits prefixed IDs into the whole string and their numeric part', () => {
		expect(kinds('INV-0042')).toEqual([
			['text', 'INV-0042'],
			['integer', '42'],
			['text', '0042']
		]);
		expect(kinds('#1234')).toEqual([
			['text', '#1234'],
			['integer', '1234']
		]);
	});

	it('lowers confidence for integers with leading zeros and keeps them as text', () => {
		const found = candidates('00042');
		expect(found.map((candidate) => [candidate.kind, candidate.value])).toEqual([
			['integer', '42'],
			['text', '00042']
		]);
		expect(found[0].confidence).toBeLessThan(found[1].confidence);
	});

	it('treats integers too large for int8 as text', () => {
		expect(kinds('99999999999999999999')).toEqual([['text', '99999999999999999999']]);
	});

	it('reads dates as ranges covering the precision given', () => {
		const [day] = candidates('2026-03-01');
		expect(day.kind === 'timestamp' && day.span).toEqual({
			from: '2026-03-01 00:00:00.000',
			to: '2026-03-02 00:00:00.000',
			zone: null,
			unit: 'day'
		});
		const [moment] = candidates('2026-03-01T10:15:30Z');
		expect(moment.kind === 'timestamp' && moment.span).toEqual({
			from: '2026-03-01 10:15:30.000',
			to: '2026-03-01 10:15:31.000',
			zone: '+00:00',
			unit: 'time'
		});
		expect(
			candidates('03/04/2026').flatMap((candidate) =>
				candidate.kind === 'timestamp' ? [candidate.span.from.slice(0, 10)] : []
			)
		).toEqual(['2026-03-04', '2026-04-03']);
		expect(kinds('Mar 1, 2026')[0]).toEqual(['timestamp', 'Mar 1, 2026']);
		expect(kinds('2026-02-30')).toEqual([['text', '2026-02-30']]);
	});

	it('recognizes IP addresses and networks', () => {
		expect(kinds('10.0.0.1')[0]).toEqual(['ip', '10.0.0.1']);
		expect(kinds('10.0.0.0/8')[0]).toEqual(['ip', '10.0.0.0/8']);
		expect(kinds('2001:db8::1')[0]).toEqual(['ip', '2001:db8::1']);
		expect(kinds('300.0.0.1').map(([kind]) => kind)).not.toContain('ip');
	});

	it('recognizes formatted phone numbers', () => {
		const [phone] = candidates('+1 (555) 123-4567');
		expect(phone.kind === 'phone' && phone.texts).toEqual([
			'+1 (555) 123-4567',
			'15551234567',
			'+15551234567'
		]);
	});

	it('feeds URL parts back through the detectors and keeps the path as a hint', () => {
		const [url] = detect('https://admin.x.com/orders/1234?tab=items', '', false);
		expect(url.detector).toBe('url');
		expect(
			url.candidates.map((candidate) => [candidate.kind, candidate.value, candidate.via])
		).toEqual([['integer', '1234', 'url']]);
		expect(url.hints).toEqual([{ word: 'orders', kind: 'exact' }]);
		expect(url.candidates[0].confidence).toBeLessThanOrEqual(0.6);
	});

	it('only falls back to plain text when nothing more specific matched', () => {
		expect(kinds('hello')).toEqual([['text', 'hello']]);
		expect(detect('42', '42', false).map(({ detector }) => detector)).toEqual(['integer', 'text']);
		expect(select(detect('42', '42', false), 'text').candidates.map(({ kind }) => kind)).toEqual([
			'text'
		]);
	});
});

describe('scope', () => {
	const tables = [table('orders', []), table('order_items', []), table('categories', [])];

	it('matches a leading word against singular and plural table names', () => {
		expect(parseScope('order 1234', tables)).toEqual({
			query: '1234',
			hint: { word: 'order', kind: 'exact' }
		});
		expect(parseScope('category: 7', tables).query).toBe('7');
		expect(parseScope('unknown 1234', tables)).toEqual({ query: 'unknown 1234', hint: undefined });
	});

	it('singularizes common plural forms', () => {
		expect(['orders', 'categories', 'addresses', 'statuses', 'cases'].map(singular)).toEqual([
			'order',
			'category',
			'address',
			'status',
			'case'
		]);
	});
});

describe('plan', () => {
	const users = withPrimaryKey(
		'users',
		[uuid('id'), text('email'), text('external_id'), text('bio')],
		{
			indexes: [
				index('users_pkey', { unique: true, column: 'id' }),
				index('users_lower_email', { expression: 'lower(email)', expressionType: 'text' })
			]
		}
	);

	it('binds UUIDs to uuid columns and to text columns named like IDs', () => {
		const { plan } = analyze('550E8400E29B41D4A716446655440000', overview([users]), null, OPTIONS);
		expect(conditionsFor(plan, 'users')).toEqual([
			{ type: 'equal', column: 'id', value: '550e8400-e29b-41d4-a716-446655440000' },
			{ type: 'equal', column: 'external_id', value: '550e8400-e29b-41d4-a716-446655440000' },
			{ type: 'equal', column: 'external_id', value: '550E8400E29B41D4A716446655440000' },
			{ type: 'equal', column: 'external_id', value: '550e8400e29b41d4a716446655440000' }
		]);
		expect(tiersFor(plan, 'users')).toEqual(['A', 'C']);
	});

	it('mirrors lower() expression indexes for emails', () => {
		const { plan } = analyze('Jane@Acme.com', overview([users]), null, OPTIONS);
		expect(conditionsFor(plan, 'users')).toContainEqual({
			type: 'index',
			index: 'users_lower_email',
			value: 'jane@acme.com'
		});
		expect(plan.insensitive).toBe(true);
	});

	it('matches emails case-insensitively through citext and offers a retry for plain text', () => {
		const accounts = table('accounts', [citext('email')]);
		const people = table('people', [text('email')]);
		const { plan } = analyze('Jane@Acme.com', overview([accounts, people]), null, OPTIONS);
		expect(conditionsFor(plan, 'accounts')).toEqual([
			{ type: 'equal', column: 'email', value: 'Jane@Acme.com' }
		]);
		expect(conditionsFor(plan, 'people')).toEqual([
			{ type: 'equal', column: 'email', value: 'Jane@Acme.com' },
			{ type: 'equal', column: 'email', value: 'jane@acme.com' }
		]);
		expect(plan.insensitive).toBe(true);
		const retried = analyze('Jane@Acme.com', overview([people]), null, {
			...OPTIONS,
			insensitive: true
		}).plan;
		expect(conditionsFor(retried, 'people')).toContainEqual({
			type: 'insensitive',
			column: 'email',
			value: 'Jane@Acme.com'
		});
	});

	it('skips int4 columns for values that overflow them', () => {
		const ledger = withPrimaryKey('ledger', [int8('id'), int4('account_id'), text('ref_no')]);
		const { plan } = analyze('99999999999', overview([ledger]), null, OPTIONS);
		expect(conditionsFor(plan, 'ledger')).toEqual([
			{ type: 'equal', column: 'id', value: '99999999999' },
			{ type: 'equal', column: 'ref_no', value: '99999999999' }
		]);
	});

	it('searches text columns for integers with leading zeros', () => {
		const invoices = withPrimaryKey('invoices', [int4('id'), text('number')]);
		const { plan } = analyze('00042', overview([invoices]), null, OPTIONS);
		expect(conditionsFor(plan, 'invoices')).toEqual([
			{ type: 'equal', column: 'id', value: '42' },
			{ type: 'equal', column: 'number', value: '42' },
			{ type: 'equal', column: 'number', value: '00042' }
		]);
	});

	it('skips unindexed columns on large tables until opted in', () => {
		const events = withPrimaryKey('events', [int8('id'), text('message_id')], {
			rowCount: 500_000_000,
			rowCountExact: false
		});
		const { plan } = analyze('ord_8f3k', overview([events]), null, OPTIONS);
		expect(plan.probes).toEqual([]);
		expect(plan.skipped).toEqual([{ table: events, columns: ['message_id'] }]);
		const optedIn = analyze('ord_8f3k', overview([events]), null, {
			...OPTIONS,
			optIns: ['public.events']
		}).plan;
		expect(conditionsFor(optedIn, 'events')).toContainEqual({
			type: 'equal',
			column: 'message_id',
			value: 'ord_8f3k'
		});
	});

	it('uses trigram and jsonb indexes only on small tables', () => {
		const indexes = [
			index('notes_body_trgm', { method: 'gin', column: 'body', operatorClass: 'gin_trgm_ops' }),
			index('notes_data_gin', { method: 'gin', column: 'data', operatorClass: 'jsonb_ops' }),
			index('notes_external', {
				expression: "(data ->> 'external_id'::text)",
				expressionType: 'text',
				unique: true
			})
		];
		const columns = [int8('id'), text('body'), column('data', 'jsonb', 3802)];
		const small = withPrimaryKey('notes', columns, { indexes });
		const { plan } = analyze('ord_8f3k', overview([small]), null, OPTIONS);
		expect(conditionsFor(plan, 'notes')).toEqual([
			{ type: 'trigram', column: 'body', value: 'ord_8f3k' },
			{ type: 'json', column: 'data', value: 'ord_8f3k', number: false },
			{ type: 'index', index: 'notes_external', value: 'ord_8f3k' },
			{ type: 'trigram', column: 'body', value: '8f3k' },
			{ type: 'json', column: 'data', value: '8f3k', number: false },
			{ type: 'index', index: 'notes_external', value: '8f3k' }
		]);
		const large = { ...small, rowCount: 1_000_000 };
		const skipped = analyze('ord_8f3k', overview([large]), null, OPTIONS).plan;
		expect(skipped.probes).toEqual([]);
		expect(skipped.extrasSkipped).toBe(1);
	});

	it('searches dates as ranges in the column type', () => {
		const orders = withPrimaryKey('orders', [int8('id'), timestamptz('created_at')], {
			indexes: [
				index('orders_pkey', { unique: true, column: 'id' }),
				index('orders_created_at', { column: 'created_at' })
			]
		});
		const { plan } = analyze('2026-03-01', overview([orders]), null, {
			...OPTIONS,
			timeZone: 'Europe/Berlin'
		});
		expect(conditionsFor(plan, 'orders')).toEqual([
			{
				type: 'range',
				column: 'created_at',
				from: '2026-03-01 00:00:00.000 Europe/Berlin',
				to: '2026-03-02 00:00:00.000 Europe/Berlin'
			}
		]);
	});

	it('searches partitioned parents and skips views', () => {
		const events = withPrimaryKey('events', [int4('id')], { kind: 'partitionedTable' });
		const recent = table('recent', [int4('id')], { kind: 'view' });
		const { plan } = analyze('42', overview([events, recent]), null, OPTIONS);
		expect(plan.probes.map(({ table }) => table.name)).toEqual(['events']);
	});

	it('orders schemas on the search path first and reports coverage', () => {
		const auth = withPrimaryKey('users', [int4('id')], { schema: 'auth', rowSecurity: true });
		const pub = withPrimaryKey('users', [int4('id')]);
		const { plan } = analyze(
			'42',
			overview([auth, pub], { restricted: [{ schema: 'public', name: 'payroll' }] }),
			null,
			OPTIONS
		);
		expect(plan.probes.map(({ table }) => table.schema)).toEqual(['public', 'auth']);
		expect(plan.searched).toEqual({ columns: 2, tables: 2 });
		expect(plan.restricted).toBe(1);
		expect(plan.rowSecurity).toBe(1);
	});

	it('marks columns of composite primary keys as partial keys', () => {
		const memberships = table('memberships', [int4('tenant_id'), int4('id')], {
			primaryKey: ['tenant_id', 'id'],
			indexes: [index('memberships_pkey', { unique: true, keyCount: 2, column: 'tenant_id' })]
		});
		const { plan } = analyze('42', overview([memberships]), null, OPTIONS);
		expect(
			plan.probes.map(({ tier, targets }) => [tier, targets.map((t) => t.partialKey)])
		).toEqual([
			['B', [true]],
			['C', [true]]
		]);
	});
});

const rows = (
	columns: string[],
	cells: (string | null)[][],
	matched: boolean[][]
): ProbeOutcome => ({
	type: 'rows',
	columns,
	hits: cells.map((row, position) => ({
		cells: row.map((value) => (value === null ? null : { kind: 'text', text: value })),
		matched: matched[position]
	})),
	limit: 6
});

const ranked = (
	input: string,
	tables: Table[],
	respond: (name: string, tier: string) => ProbeOutcome
) => {
	const schema = overview(tables);
	const analysis = analyze(input, schema, null, OPTIONS);
	return rank({
		plan: analysis.plan,
		outcomes: analysis.plan.probes.map((probe) => respond(probe.table.name, probe.tier)),
		hints: analysis.hints,
		history: () => 0,
		query: analysis.query,
		searchPath: schema.searchPath
	});
};

const none = rows([], [], []);

describe('rank', () => {
	const id = '550e8400-e29b-41d4-a716-446655440000';

	it('jumps to the only strong hit', () => {
		const users = withPrimaryKey('users', [uuid('id'), text('name')]);
		const ranking = ranked(id, [users], () => rows(['id', 'name'], [[id, 'Ada']], [[true]]));
		expect(ranking.jump?.filter).toEqual([{ column: 'id', value: id }]);
		expect(ranking.jump?.identity).toBe(id);
	});

	it('does not jump to ambiguous small integers and asks for a hint instead', () => {
		const names = ['orders', 'users', 'invoices', 'refunds', 'teams'];
		const tables = names.map((name) => withPrimaryKey(name, [int4('id')]));
		const ranking = ranked('42', tables, () => rows(['id'], [['42']], [[true]]));
		expect(ranking.jump).toBeUndefined();
		expect(ranking.groups).toHaveLength(5);
		expect(ranking.weak).toEqual({ tables: 5, example: expect.stringMatching(/^\w+ 42$/) });
	});

	it('jumps to integers when a scope hint names the table', () => {
		const tables = ['orders', 'users'].map((name) => withPrimaryKey(name, [int4('id')]));
		const ranking = ranked('order 42', tables, (name) =>
			name === 'orders' ? rows(['id'], [['42']], [[true]]) : none
		);
		expect(ranking.jump?.table.name).toBe('orders');
	});

	it('does not jump when a hit is only part of a composite key', () => {
		const memberships = table('memberships', [int4('tenant_id'), int4('id')], {
			primaryKey: ['tenant_id', 'id'],
			indexes: [index('memberships_pkey', { unique: true, keyCount: 2, column: 'tenant_id' })]
		});
		const ranking = ranked('membership 42', [memberships], (_, tier) =>
			tier === 'C' ? rows(['tenant_id', 'id'], [['1', '42']], [[true]]) : none
		);
		expect(ranking.jump).toBeUndefined();
		expect(ranking.groups[0].hits[0].reasons[0].target.partialKey).toBe(true);
	});

	it('waits for every Tier A statement before jumping', () => {
		const users = withPrimaryKey('users', [uuid('id')]);
		const schema = overview([users]);
		const analysis = analyze(id, schema, null, OPTIONS);
		const ranking = rank({
			plan: analysis.plan,
			outcomes: analysis.plan.probes.map(() => ({ type: 'timedOut' })),
			hints: analysis.hints,
			history: () => 0,
			query: analysis.query,
			searchPath: []
		});
		expect(ranking.jump).toBeUndefined();
		expect(ranking.timedOut).toBe(1);
	});

	it('groups foreign-key hits under the row they reference', () => {
		const orders = withPrimaryKey('orders', [int8('id')]);
		const refund = (name: string) =>
			withPrimaryKey(name, [int8('id'), int8('order_id')], {
				foreignKeys: [
					{
						name: `${name}_order_id_fkey`,
						columns: ['order_id'],
						referencedSchema: 'public',
						referencedTable: 'orders',
						referencedColumns: ['id']
					}
				],
				indexes: [
					index(`${name}_pkey`, { unique: true, column: 'id' }),
					index(`${name}_order_id`, { column: 'order_id' })
				]
			});
		const ranking = ranked(
			'order 1234',
			[orders, refund('refunds'), refund('shipments')],
			(name, tier) => {
				if (name === 'orders') return rows(['id'], [['1234']], [[true]]);
				if (tier !== 'B') return none;
				return name === 'refunds'
					? rows(
							['id', 'order_id'],
							[
								['1', '1234'],
								['2', '1234']
							],
							[[true], [true]]
						)
					: rows(['id', 'order_id'], [['9', '1234']], [[true]]);
			}
		);
		expect(ranking.groups.map(({ table }) => table.name)).toEqual(['orders']);
		expect(
			ranking.groups[0].hits[0].related.map(({ table, count }) => [table.name, count])
		).toEqual([
			['refunds', 2],
			['shipments', 1]
		]);
	});

	it('ranks the search path first when scores tie', () => {
		const auth = withPrimaryKey('users', [int4('id')], { schema: 'auth' });
		const pub = withPrimaryKey('users', [int4('id')]);
		const ranking = ranked('42', [auth, pub], () => rows(['id'], [['42']], [[true]]));
		expect(ranking.groups.map(({ table }) => table.schema)).toEqual(['public', 'auth']);
	});

	it('counts denied and failed statements without failing the search', () => {
		const tables = ['a', 'b', 'c'].map((name) => withPrimaryKey(name, [int4('id')]));
		const ranking = ranked('42', tables, (name) =>
			name === 'a'
				? { type: 'denied' }
				: name === 'b'
					? { type: 'failed', message: 'boom' }
					: rows(['id'], [['42']], [[true]])
		);
		expect(ranking.denied).toBe(1);
		expect(ranking.failed.map(({ message }) => message)).toEqual(['boom']);
		expect(ranking.groups.map(({ table }) => table.name)).toEqual(['c']);
		expect(ranking.done).toBe(true);
	});
});
