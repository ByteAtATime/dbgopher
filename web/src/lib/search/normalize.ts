export type Normalized = { raw: string; value: string; multiline: boolean };

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const SMART_QUOTES = new Map([
	['\u201C', '"'],
	['\u201D', '"'],
	['\u201E', '"'],
	['\u2018', "'"],
	['\u2019', "'"],
	['\u201A', "'"]
]);
const QUOTES = ['```', '"', "'", '`'];
const TRAILING_PUNCTUATION = /[.,;]+$/;

const count = (value: string, character: string) => value.split(character).length - 1;

const unwrap = (value: string) => {
	for (const quote of QUOTES) {
		if (value.length > quote.length * 2 && value.startsWith(quote) && value.endsWith(quote)) {
			return value.slice(quote.length, -quote.length);
		}
	}
	if (value.startsWith('(') && value.endsWith(')') && count(value, '(') === count(value, ')')) {
		return value.slice(1, -1);
	}
	return value;
};

const strip = (value: string) => {
	const stripped = value.replace(TRAILING_PUNCTUATION, '');
	if (stripped.endsWith(')') && count(stripped, ')') > count(stripped, '(')) {
		return stripped.slice(0, -1);
	}
	return stripped;
};

export const normalize = (input: string): Normalized => {
	const lines = input
		.split(/\r\n|\r|\n/)
		.filter((line) => line.replace(ZERO_WIDTH, '').trim() !== '');
	const raw = lines[0] ?? '';
	let value = raw
		.replace(ZERO_WIDTH, '')
		.replace(/[\u201C\u201D\u201E\u2018\u2019\u201A]/g, (quote) => SMART_QUOTES.get(quote) ?? quote);
	let previous: string;
	do {
		previous = value;
		value = unwrap(strip(value.trim()));
	} while (value !== previous);
	return { raw, value, multiline: lines.length > 1 };
};
