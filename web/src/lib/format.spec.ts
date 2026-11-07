import { describe, expect, it } from 'vitest';
import { formatRelativeTime, formatUtcTimestamp } from './format';

const now = Date.UTC(2026, 10, 6, 12);
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

describe('formatRelativeTime', () => {
	it.each([
		[now - 5_000, relative.format(-5, 'second')],
		[now, relative.format(0, 'second')],
		[now - 90 * 60_000, relative.format(-2, 'hour')],
		[now - 3 * 24 * 3_600_000, relative.format(-3, 'day')],
		[now + 2 * 7 * 24 * 3_600_000, relative.format(2, 'week')],
		[now - 400 * 24 * 3_600_000, relative.format(-1, 'year')]
	])('formats %i relative to now', (time, expected) => {
		expect(formatRelativeTime(new Date(time), now)).toBe(expected);
	});
});

describe('formatUtcTimestamp', () => {
	it.each([
		[Date.UTC(2026, 10, 6, 17, 48, 12, 999), '2026-11-06 17:48:12'],
		[Date.UTC(2026, 0, 2, 3, 4, 5), '2026-01-02 03:04:05']
	])('formats %i', (time, expected) => {
		expect(formatUtcTimestamp(new Date(time))).toBe(expected);
	});

	it('pads years below 1000', () => {
		const date = new Date(0);
		date.setUTCFullYear(50, 5, 1);
		expect(formatUtcTimestamp(date)).toBe('0050-06-01 00:00:00');
	});
});
