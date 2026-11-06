import { describe, expect, it } from 'vitest';
import type { Column } from '../protocol/bindings/Column';
import type { Index } from '../protocol/bindings/Index';
import type { Overview } from '../protocol/bindings/Overview';
import type { Table } from '../protocol/bindings/Table';
import { detect } from './detect';
import { plan, tier, type Target } from './plan';

const TYPES = {
	int4: [23, 'integer'],
	int8: [20, 'bigint'],
	text: [25, 'text'],
	varchar: [1043, 'character varying(255)'],
	uuid: [2950, 'uuid'],
	char32: [1042, 'character(32)'],
	date: [1082, 'date']
} as const;

const column = (name: string, type: keyof typeof TYPES): Column => ({
	name,
	typeOid: TYPES[type][0],
	typeName: TYPES[type][1],
	nullable: false,
	hasDefault: false
});

const index = (
	name: string,
	keys: (string | { lower: string })[],
	flags: Partial<Pick<Index, 'method' | 'unique' | 'partial'>> = {}
): Index => ({
	name,
	method: 'btree',
	unique: false,
	partial: false,
	keys: keys.map((key) =>
		typeof key === 'string'
			? { kind: 'column', name: key, operatorClass: 'default' }
			: {
					kind: 'expression',
					definition: `lower(${key.lower})`,
					typeOid: 25,
					typeName: 'text',
					operatorClass: 'text_ops'
				}
	),
	...flags
});

const table = (
	name: string,
	columns: Column[],
	options: Partial<
		Pick<Table, 'schema' | 'kind' | 'rowCount' | 'primaryKey' | 'indexes' | 'foreignKeys'>
	> = {}
): Table => {
	const primaryKey = options.primaryKey ?? [];
	return {
		schema: 'public',
		name,
		kind: 'table',
		rowCount: 10,
		rowCountExact: true,
		totalBytes: 0,
		columns,
		primaryKey,
		foreignKeys: [],
		...options,
		indexes: [
			...(primaryKey.length > 0 ? [index(`${name}_pkey`, primaryKey, { unique: true })] : []),
			...(options.indexes ?? [])
		]
	};
};

const overview = (tables: Table[], extra: Partial<Overview> = {}): Overview => ({
	searchPath: ['public'],
	fingerprint: '0',
	tables,
	unreadableTables: [],
	...extra
});

const run = (input: string, tables: Table[], extra: Partial<Overview> = {}) =>
	plan(detect(input).candidates, overview(tables, extra));

const where = ({ table, column, comparison, typeOid, value, access }: Target) => ({
	table,
	column,
	comparison,
	typeOid,
	value,
	access
});

const UUID = '550e8400-e29b-41d4-a716-446655440000';

const customers = table('customers', [column('id', 'int4'), column('email', 'text')], {
	primaryKey: ['id'],
	indexes: [index('customers_email_lower', [{ lower: 'email' }], { unique: true })]
});

const orders = table(
	'orders',
	[column('id', 'int8'), column('customer_id', 'int4'), column('note', 'text')],
	{
		primaryKey: ['id'],
		foreignKeys: [
			{
				name: 'orders_customer_id_fkey',
				columns: ['customer_id'],
				referencedSchema: 'public',
				referencedTable: 'customers',
				referencedColumns: ['id']
			}
		],
		indexes: [index('orders_customer', ['customer_id'])]
	}
);

describe('tier', () => {
	it.each([
		['primaryKey', 'A'],
		['unique', 'A'],
		['foreignKey', 'B'],
		['index', 'B'],
		['none', 'C']
	] as const)('puts %s in tier %s', (access, expected) => {
		expect(tier(access)).toBe(expected);
	});
});

describe('plan', () => {
	it('binds integers as each column type, skipping columns they overflow', () => {
		expect(run('99999999999', [customers, orders]).targets.map(where)).toEqual([
			{
				table: 'orders',
				column: 'id',
				comparison: 'equal',
				typeOid: 20,
				value: '99999999999',
				access: 'primaryKey'
			}
		]);
	});

	it('orders targets by tier and labels foreign keys', () => {
		expect(run('42', [customers, orders]).targets.map(where)).toEqual([
			{
				table: 'customers',
				column: 'id',
				comparison: 'equal',
				typeOid: 23,
				value: '42',
				access: 'primaryKey'
			},
			{
				table: 'orders',
				column: 'id',
				comparison: 'equal',
				typeOid: 20,
				value: '42',
				access: 'primaryKey'
			},
			{
				table: 'orders',
				column: 'customer_id',
				comparison: 'equal',
				typeOid: 23,
				value: '42',
				access: 'foreignKey'
			}
		]);
	});

	it('mirrors lower() expression indexes for emails', () => {
		expect(run('Jane@Acme.com', [customers]).targets.map(where)).toEqual([
			{
				table: 'customers',
				column: 'email',
				comparison: 'lowerEqual',
				typeOid: 25,
				value: 'jane@acme.com',
				access: 'unique'
			}
		]);
	});

	it.each(['lower((email)::text)', 'lower("email")'])(
		'recognizes %s as a lower() index',
		(definition) => {
			const indexed = table('people', [column('email', 'varchar')], {
				rowCount: 1_000_000,
				indexes: [
					{
						...index('people_email', [{ lower: 'email' }]),
						keys: [
							{
								kind: 'expression',
								definition,
								typeOid: 25,
								typeName: 'text',
								operatorClass: 'text_ops'
							}
						]
					}
				]
			});
			expect(run('a@b.co', [indexed]).targets.map(where)).toEqual([
				{
					table: 'people',
					column: 'email',
					comparison: 'lowerEqual',
					typeOid: 25,
					value: 'a@b.co',
					access: 'index'
				}
			]);
		}
	);

	it('searches unindexed columns on small tables only', () => {
		const small = table('invites', [column('email', 'text')]);
		const large = table('logs', [column('email', 'text')], { rowCount: 500_000_000 });
		const unknown = table('drafts', [column('email', 'text')], { rowCount: null });
		const { targets, coverage } = run('x@y.co', [small, large, unknown]);
		expect(targets.map(where)).toEqual([
			{
				table: 'invites',
				column: 'email',
				comparison: 'equal',
				typeOid: 25,
				value: 'x@y.co',
				access: 'none'
			}
		]);
		expect(coverage).toEqual([
			{
				kind: 'unindexed',
				schema: 'public',
				table: 'logs',
				columns: ['email'],
				rowCount: 500_000_000
			},
			{ kind: 'unindexed', schema: 'public', table: 'drafts', columns: ['email'], rowCount: null }
		]);
	});

	it('matches uuids against uuid columns and id-like text columns', () => {
		const accounts = table(
			'accounts',
			[
				column('id', 'uuid'),
				column('external_id', 'text'),
				column('legacy_id', 'char32'),
				column('note', 'text')
			],
			{ primaryKey: ['id'] }
		);
		expect(run(UUID.toUpperCase(), [accounts]).targets.map(where)).toEqual([
			{
				table: 'accounts',
				column: 'id',
				comparison: 'equal',
				typeOid: 2950,
				value: UUID,
				access: 'primaryKey'
			},
			{
				table: 'accounts',
				column: 'external_id',
				comparison: 'equal',
				typeOid: 25,
				value: UUID,
				access: 'none'
			},
			{
				table: 'accounts',
				column: 'legacy_id',
				comparison: 'equal',
				typeOid: 1042,
				value: UUID.replaceAll('-', ''),
				access: 'none'
			}
		]);
	});

	it('limits plain text to unique or id-like columns', () => {
		const products = table(
			'products',
			[column('sku', 'text'), column('slug', 'text'), column('name', 'text')],
			{ indexes: [index('products_sku', ['sku'], { unique: true })] }
		);
		expect(run('blue-widget-large', [products]).targets.map(({ column }) => column)).toEqual([
			'sku',
			'slug'
		]);
	});

	it('ignores partial indexes', () => {
		const tasks = table('tasks', [column('owner_id', 'int4')], {
			rowCount: 1_000_000,
			indexes: [index('tasks_open_owner', ['owner_id'], { partial: true })]
		});
		expect(run('7', [tasks]).coverage).toEqual([
			{
				kind: 'unindexed',
				schema: 'public',
				table: 'tasks',
				columns: ['owner_id'],
				rowCount: 1_000_000
			}
		]);
	});

	it('flags members of a composite primary key as partial keys', () => {
		const events = table('events', [column('id', 'int4'), column('at', 'date')], {
			kind: 'partitionedTable',
			primaryKey: ['id', 'at']
		});
		expect(run('5', [events]).targets).toEqual([
			expect.objectContaining({ column: 'id', access: 'index', partialKey: true })
		]);
	});

	it('marks targets whose table matches the scope hint, singular or plural', () => {
		const addresses = table('addresses', [column('id', 'int4')], { primaryKey: ['id'] });
		const scoped = (input: string) =>
			Object.fromEntries(
				run(input, [customers, addresses]).targets.map((t) => [t.table, t.scoped])
			);
		expect(scoped('address 3')).toEqual({ customers: false, addresses: true });
		expect(scoped('customers: 3')).toEqual({ customers: true, addresses: false });
		expect(scoped('3')).toEqual({ customers: false, addresses: false });
	});

	it('ranks schemas on the search path first within a tier', () => {
		const users = (schema: string) =>
			table('users', [column('id', 'int4')], { schema, primaryKey: ['id'] });
		const { targets } = run('1', [users('auth'), users('public'), users('app')], {
			searchPath: ['app', 'public']
		});
		expect(targets.map(({ schema }) => schema)).toEqual(['app', 'public', 'auth']);
	});

	it('skips views and reports unreadable tables', () => {
		const recent = table('recent_orders', [column('id', 'int8')], { kind: 'view' });
		const { targets, coverage } = run('1', [recent], {
			unreadableTables: [
				{ schema: 'public', name: 'payroll', kind: 'table' },
				{ schema: 'public', name: 'payroll_view', kind: 'view' }
			]
		});
		expect(targets).toEqual([]);
		expect(coverage).toEqual([{ kind: 'unreadable', schema: 'public', table: 'payroll' }]);
	});

	it('plans nothing without candidates', () => {
		expect(run('', [customers, orders])).toEqual({ targets: [], coverage: [] });
	});
});
