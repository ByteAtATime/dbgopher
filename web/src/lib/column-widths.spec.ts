import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadColumnWidths, saveColumnWidth } from './column-widths';

const customers = { connectorId: 'c1', schema: 'public', table: 'customers' };
const orders = { connectorId: 'c1', schema: 'public', table: 'orders' };
const otherConnector = { connectorId: 'c2', schema: 'public', table: 'customers' };

beforeEach(() => {
	const items = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => items.set(key, value)
	});
});

describe('column widths', () => {
	it('keeps widths per connector and table', () => {
		saveColumnWidth(customers, 'id', 90);
		saveColumnWidth(customers, 'email', 410);
		saveColumnWidth(orders, 'id', 120);

		expect(loadColumnWidths(customers)).toEqual(
			new Map([
				['id', 90],
				['email', 410]
			])
		);
		expect(loadColumnWidths(orders)).toEqual(new Map([['id', 120]]));
		expect(loadColumnWidths(otherConnector)).toEqual(new Map());
	});

	it('ignores unreadable stored data', () => {
		const key = 'dbgopher:column-widths:["c1","public","customers"]';
		localStorage.setItem(key, '{"id":"wide"}');
		expect(loadColumnWidths(customers)).toEqual(new Map());

		localStorage.setItem(key, 'not json');
		expect(loadColumnWidths(customers)).toEqual(new Map());
	});

	it('falls back to defaults when storage is unavailable', () => {
		vi.stubGlobal('localStorage', {
			getItem: () => {
				throw new Error('denied');
			},
			setItem: () => {
				throw new Error('quota');
			}
		});
		expect(() => saveColumnWidth(customers, 'id', 90)).not.toThrow();
		expect(loadColumnWidths(customers)).toEqual(new Map());
	});
});
