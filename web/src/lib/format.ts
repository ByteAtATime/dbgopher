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
