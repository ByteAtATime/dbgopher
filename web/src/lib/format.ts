const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

const exactCount = new Intl.NumberFormat();
const estimatedCount = new Intl.NumberFormat(undefined, {
	notation: 'compact',
	maximumFractionDigits: 1
});

export const formatRowCount = (count: number | null, exact: boolean) => {
	if (count === null) return '—';
	return exact ? exactCount.format(count) : `≈${estimatedCount.format(count)}`;
};

export const formatBytes = (bytes: number) => {
	const exponent = Math.min(
		Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(1024)),
		BYTE_UNITS.length - 1
	);
	return new Intl.NumberFormat(undefined, {
		style: 'unit',
		unit: BYTE_UNITS[exponent],
		unitDisplay: 'short',
		maximumFractionDigits: 1
	}).format(bytes / 1024 ** exponent);
};
