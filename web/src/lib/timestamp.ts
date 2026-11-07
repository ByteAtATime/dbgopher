import type { Column } from './protocol/bindings/Column';

export type Instant = { date: Date; iso: string };

const TIMESTAMP_OIDS = new Set([1114, 1184]);
const TIMESTAMP =
	/^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?)?$/;

export const isTimestampColumn = (column: Pick<Column, 'typeOid'>) =>
	TIMESTAMP_OIDS.has(column.typeOid);

export const instantOf = (date: Date): Instant => ({ date, iso: date.toISOString() });

export const parseTimestamp = (text: string): Instant | undefined => {
	const match = TIMESTAMP.exec(text);
	if (!match) return undefined;
	const [
		,
		year,
		month,
		day,
		hour,
		minute,
		second,
		fraction = '',
		sign,
		offsetHours = '0',
		offsetMinutes = '0',
		offsetSeconds = '0'
	] = match;
	const offset =
		(sign === '-' ? -1 : 1) *
		(Number(offsetHours) * 3600 + Number(offsetMinutes) * 60 + Number(offsetSeconds));
	const date = new Date(0);
	date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
	date.setUTCHours(
		Number(hour),
		Number(minute),
		Number(second) - offset,
		Number(fraction.padEnd(3, '0').slice(0, 3))
	);
	if (Number.isNaN(date.getTime())) return undefined;
	return { date, iso: date.toISOString().replace(/\.\d{3}Z$/, `.${fraction.padEnd(3, '0')}Z`) };
};
