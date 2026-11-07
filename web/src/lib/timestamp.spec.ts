import { describe, expect, it } from 'vitest';
import { parseTimestamp } from './timestamp';

describe('parseTimestamp', () => {
	it.each([
		['2026-11-06T12:34:56', '2026-11-06T12:34:56.000Z'],
		['2026-11-06T12:34:56.123456', '2026-11-06T12:34:56.123456Z'],
		['2026-11-06T12:34:56.5+00:00', '2026-11-06T12:34:56.500Z'],
		['2026-11-06T12:34:56.000001-08:00', '2026-11-06T20:34:56.000001Z'],
		['2026-11-07T01:04:56+05:30', '2026-11-06T19:34:56.000Z'],
		['1900-01-01T00:00:00+00:19:32', '1899-12-31T23:40:28.000Z'],
		['0050-06-01T00:00:00', '0050-06-01T00:00:00.000Z']
	])('parses %s', (text, iso) => {
		expect(parseTimestamp(text)?.iso).toBe(iso);
	});

	it('keeps the date at millisecond precision', () => {
		expect(parseTimestamp('2026-11-06T12:34:56.123456+00:00')?.date.getTime()).toBe(
			Date.UTC(2026, 10, 6, 12, 34, 56, 123)
		);
	});

	it.each(['infinity', '-infinity', '0044-03-15T00:00:00 BC', 'not a time'])(
		'leaves %s unparsed',
		(text) => {
			expect(parseTimestamp(text)).toBeUndefined();
		}
	);
});
