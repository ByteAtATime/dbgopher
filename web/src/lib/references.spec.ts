import { describe, expect, it } from 'vitest';
import type { ForeignKey } from './protocol/bindings/ForeignKey';
import type { Table } from './protocol/bindings/Table';
import type { Browse } from './protocol/client';
import {
	incomingReferences,
	outgoingReferences,
	referenceFilter,
	type Reference
} from './references';

const table = (schema: string, name: string, foreignKeys: Omit<ForeignKey, 'name'>[] = []) =>
	({
		schema,
		name,
		kind: 'table',
		rowCount: 0,
		rowCountExact: true,
		totalBytes: 0,
		columns: [],
		primaryKey: [],
		foreignKeys: foreignKeys.map((key) => ({ name: key.columns.join('_'), ...key })),
		indexes: []
	}) satisfies Table;

const to = (referencedTable: string, columns: string[], referencedColumns = ['id']) => ({
	columns,
	referencedSchema: 'public',
	referencedTable,
	referencedColumns
});

describe('incomingReferences', () => {
	it('labels each referencing table, adding columns only when a table refers twice', () => {
		const tables = [
			table('public', 'addresses'),
			table('public', 'orders', [
				to('addresses', ['billing_address_id']),
				to('addresses', ['shipping_address_id']),
				to('customers', ['customer_id'])
			]),
			table('public', 'customers', [to('addresses', ['home_address_id'])]),
			table('audit', 'moves', [to('addresses', ['address_id'])])
		];
		expect(
			incomingReferences(tables, 'public', 'addresses').map(({ label, schema, table }) => ({
				label,
				schema,
				table
			}))
		).toEqual([
			{ label: 'orders.billing_address_id', schema: 'public', table: 'orders' },
			{ label: 'orders.shipping_address_id', schema: 'public', table: 'orders' },
			{ label: 'customers', schema: 'public', table: 'customers' },
			{ label: 'audit.moves', schema: 'audit', table: 'moves' }
		]);
	});

	it('orders self-references first, then tables that refer twice, then the rest', () => {
		const tables = [
			table('public', 'comments', [to('posts', ['post_id'])]),
			table('public', 'links', [to('posts', ['from_id']), to('posts', ['to_id'])]),
			table('public', 'posts', [to('posts', ['parent_id']), to('posts', ['quoted_id'])]),
			table('public', 'tags', [to('posts', ['post_id'])])
		];
		expect(incomingReferences(tables, 'public', 'posts').map(({ label }) => label)).toEqual([
			'posts.parent_id',
			'posts.quoted_id',
			'links.from_id',
			'links.to_id',
			'comments',
			'tags'
		]);
	});

	it('names the column when a table refers to itself', () => {
		const tables = [table('public', 'employees', [to('employees', ['manager_id'])])];
		expect(incomingReferences(tables, 'public', 'employees')).toEqual([
			{
				label: 'employees.manager_id',
				schema: 'public',
				table: 'employees',
				columns: ['manager_id'],
				referencedColumns: ['id']
			}
		]);
	});
});

describe('outgoingReferences', () => {
	it('points each foreign key at the referenced row, qualifying other schemas', () => {
		const tables = [
			table('public', 'customers'),
			table('public', 'orders', [
				to('customers', ['customer_id']),
				{ ...to('regions', ['region_code'], ['code']), referencedSchema: 'geo' }
			])
		];
		expect(outgoingReferences(tables, 'public', 'orders')).toEqual([
			{
				label: 'customers',
				schema: 'public',
				table: 'customers',
				columns: ['id'],
				referencedColumns: ['customer_id']
			},
			{
				label: 'geo.regions',
				schema: 'geo',
				table: 'regions',
				columns: ['code'],
				referencedColumns: ['region_code']
			}
		]);
	});

	it('gives nothing for an unknown table', () => {
		expect(outgoingReferences([], 'public', 'orders')).toEqual([]);
	});
});

describe('referenceFilter', () => {
	const reference: Reference = {
		label: 'shipments',
		schema: 'public',
		table: 'shipments',
		columns: ['order_id', 'item'],
		referencedColumns: ['order_id', 'position']
	};
	const text = (value: string) => ({ kind: 'text' as const, text: value });
	const column = (name: string) => ({
		name,
		typeOid: 23,
		typeName: 'integer',
		nullable: true,
		hasDefault: false
	});
	const rows: Browse = {
		type: 'browse',
		columns: [column('position'), column('quantity'), column('order_id')],
		rows: [
			[text('2'), text('1.5'), text('7')],
			[null, text('1'), text('8')]
		]
	};

	it('maps referenced cells of a row onto the referencing columns', () => {
		expect(referenceFilter(reference, rows, 0)).toEqual([
			{ column: 'order_id', value: '7' },
			{ column: 'item', value: '2' }
		]);
	});

	it('gives nothing when a referenced cell is null', () => {
		expect(referenceFilter(reference, rows, 1)).toBeUndefined();
	});
});
