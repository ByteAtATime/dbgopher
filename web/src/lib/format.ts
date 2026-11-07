const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

const exactCount = new Intl.NumberFormat();
const estimatedCount = new Intl.NumberFormat(undefined, {
	notation: 'compact',
	maximumFractionDigits: 1
});
const byteCount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export const formatRowCount = (count: number | null, exact: boolean) => {
	if (count === null) return '—';
	return exact ? exactCount.format(count) : `≈${estimatedCount.format(count)}`;
};

export const formatBytes = (bytes: number, unitDisplay: 'short' | 'narrow' = 'short') => {
	const exponent = Math.min(
		Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)),
		BYTE_UNITS.length - 1
	);
	const separator = unitDisplay === 'narrow' ? '' : '\u00A0';
	return `${byteCount.format(bytes / 1024 ** exponent)}${separator}${BYTE_UNITS[exponent]}`;
};

const localTimestamp = new Intl.DateTimeFormat(undefined, {
	year: 'numeric',
	month: 'short',
	day: 'numeric',
	hour: 'numeric',
	minute: '2-digit',
	second: '2-digit',
	timeZoneName: 'short'
});
const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const RELATIVE_UNITS = [
	['year', 365 * 24 * 60 * 60],
	['month', 30 * 24 * 60 * 60],
	['week', 7 * 24 * 60 * 60],
	['day', 24 * 60 * 60],
	['hour', 60 * 60],
	['minute', 60],
	['second', 1]
] as const satisfies ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]>;

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

export const formatUtcTimestamp = (date: Date) =>
	`${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

export const formatLocalTimestamp = (date: Date) => localTimestamp.format(date);

export const formatRelativeTime = (date: Date, now: number = Date.now()) => {
	const seconds = (date.getTime() - now) / 1000;
	const [unit, size] =
		RELATIVE_UNITS.find(([, size]) => Math.abs(seconds) >= size) ??
		RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
	return relativeTime.format(Math.sign(seconds) * Math.round(Math.abs(seconds) / size), unit);
};
