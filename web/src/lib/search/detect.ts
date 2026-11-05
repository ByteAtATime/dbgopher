export type Detector =
	'uuid' | 'email' | 'url' | 'prefixed' | 'integer' | 'timestamp' | 'ip' | 'phone' | 'text';

export type Span = { from: string; to: string; zone: string | null; unit: 'day' | 'time' };

type Base = { detector: Detector; confidence: number; via?: 'url' };

export type Candidate = Base &
	(
		| { kind: 'uuid'; value: string; texts: string[] }
		| { kind: 'email'; value: string; texts: string[] }
		| { kind: 'integer'; value: string }
		| { kind: 'timestamp'; value: string; span: Span }
		| { kind: 'ip'; value: string }
		| { kind: 'phone'; value: string; texts: string[] }
		| { kind: 'text'; value: string; texts: string[] }
	);

export type Interpretation = { detector: Detector; candidates: Candidate[]; hints: Hint[] };

export type Hint = { word: string; kind: 'exact' | 'prefix' };

export const HIGH = 1;
export const MEDIUM = 0.6;
export const LOW = 0.3;
const LEADING_ZERO_PENALTY = 0.15;
const MAX_TEXT_LENGTH = 256;
const INT8_MAX = 9223372036854775807n;

const candidateKey = (candidate: Candidate) =>
	`${candidate.kind}\0${candidate.value}\0${candidate.kind === 'timestamp' ? candidate.span.from : ''}`;

const unique = (values: (string | undefined)[]) => [
	...new Set(values.filter((value): value is string => value !== undefined && value !== ''))
];

const UUID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

const uuid = (value: string): Candidate[] => {
	const bare = value.replace(/^urn:uuid:/i, '').replace(/^\{(.*)\}$/, '$1');
	if (!UUID.test(bare)) return [];
	const hex = bare.replaceAll('-', '').toLowerCase();
	const canonical = [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20)
	].join('-');
	return [
		{
			detector: 'uuid',
			kind: 'uuid',
			confidence: HIGH,
			value: canonical,
			texts: unique([canonical, bare, hex])
		}
	];
};

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:.]+$/;

const email = (value: string): Candidate[] => {
	const angled = /<([^<>]+)>$/.exec(value)?.[1] ?? value;
	const address = angled
		.replace(/^mailto:/i, '')
		.replace(/\?.*$/, '')
		.trim();
	if (!EMAIL.test(address)) return [];
	return [
		{
			detector: 'email',
			kind: 'email',
			confidence: HIGH,
			value: address,
			texts: unique([address, address.toLowerCase()])
		}
	];
};

const integer = (value: string, hinted: boolean, detector: Detector = 'integer'): Candidate[] => {
	const match = /^(#?)(\d+)$/.exec(value);
	if (!match) return [];
	const [, hash, digits] = match;
	const hint = hinted || hash === '#';
	const leading = digits.length > 1 && digits.startsWith('0');
	const number = BigInt(digits);
	const base = hint ? MEDIUM : LOW;
	const candidates: Candidate[] = [];
	if (number <= INT8_MAX) {
		candidates.push({
			detector,
			kind: 'integer',
			confidence: leading ? base - LEADING_ZERO_PENALTY : base,
			value: number.toString()
		});
	}
	if (leading || number > INT8_MAX) {
		candidates.push({ detector, kind: 'text', confidence: base, value: digits, texts: [digits] });
	}
	return candidates;
};

const PREFIXED = /^([A-Za-z][A-Za-z0-9]{0,15})[_-]([A-Za-z0-9][A-Za-z0-9_-]*)$/;

const prefixed = (value: string, raw: string): Interpretation | undefined => {
	if (/^#\d+$/.test(value)) {
		return {
			detector: 'prefixed',
			candidates: [
				{
					detector: 'prefixed',
					kind: 'text',
					confidence: MEDIUM,
					value,
					texts: unique([value, raw])
				},
				...integer(value, true, 'prefixed')
			],
			hints: []
		};
	}
	const match = PREFIXED.exec(value);
	if (!match) return undefined;
	const [, prefix, suffix] = match;
	const part: Candidate[] = /^\d+$/.test(suffix)
		? integer(suffix, true, 'prefixed')
		: [{ detector: 'prefixed', kind: 'text', confidence: LOW, value: suffix, texts: [suffix] }];
	return {
		detector: 'prefixed',
		candidates: [
			{
				detector: 'prefixed',
				kind: 'text',
				confidence: MEDIUM,
				value,
				texts: unique([value, raw])
			},
			...part
		],
		hints: [{ word: prefix, kind: 'prefix' }]
	};
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

type Moment = {
	year: number;
	month: number;
	day: number;
	hour?: number;
	minute?: number;
	second?: number;
	fraction?: string;
	zone?: string;
};

const pad = (value: number, length = 2) => String(value).padStart(length, '0');

const formatMoment = (time: number) => {
	const date = new Date(time);
	return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
};

const valid = ({ year, month, day }: Moment) => {
	if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
	return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
};

const zoneOffset = (zone: string | undefined) => {
	if (zone === undefined) return null;
	if (zone.toUpperCase() === 'Z') return '+00:00';
	const [, sign, hours, minutes] = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone) ?? [];
	return sign ? `${sign}${hours}:${minutes ?? '00'}` : null;
};

const span = (moment: Moment): Span => {
	const fraction = (moment.fraction ?? '').slice(0, 3);
	const start = Date.UTC(
		moment.year,
		moment.month - 1,
		moment.day,
		moment.hour ?? 0,
		moment.minute ?? 0,
		moment.second ?? 0,
		Number(fraction.padEnd(3, '0'))
	);
	const step =
		moment.hour === undefined
			? 86_400_000
			: moment.second === undefined
				? 60_000
				: fraction === ''
					? 1000
					: 10 ** (3 - fraction.length);
	return {
		from: formatMoment(start),
		to: formatMoment(start + step),
		zone: zoneOffset(moment.zone),
		unit: moment.hour === undefined ? 'day' : 'time'
	};
};

const parseMoments = (value: string): Moment[] => {
	const iso =
		/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(
			value
		);
	if (iso) {
		const [, year, month, day, hour, minute, second, fraction, zone] = iso;
		return [
			{
				year: Number(year),
				month: Number(month),
				day: Number(day),
				hour: hour === undefined ? undefined : Number(hour),
				minute: minute === undefined ? undefined : Number(minute),
				second: second === undefined ? undefined : Number(second),
				fraction,
				zone
			}
		];
	}
	const slashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
	if (slashed) {
		return [{ year: Number(slashed[1]), month: Number(slashed[2]), day: Number(slashed[3]) }];
	}
	const numeric = /^(\d{1,2})([/.])(\d{1,2})\2(\d{4})$/.exec(value);
	if (numeric) {
		const [, first, separator, second, year] = numeric;
		const dayFirst = { year: Number(year), month: Number(second), day: Number(first) };
		const monthFirst = { year: Number(year), month: Number(first), day: Number(second) };
		if (separator === '.') return [dayFirst];
		return first === second ? [monthFirst] : [monthFirst, dayFirst];
	}
	const named =
		/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(value) ??
		/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(value);
	if (named) {
		const [word, day] = /^\d/.test(named[1]) ? [named[2], named[1]] : [named[1], named[2]];
		const month = MONTHS.indexOf(word.slice(0, 3).toLowerCase()) + 1;
		if (month === 0) return [];
		return [{ year: Number(named[3]), month, day: Number(day) }];
	}
	return [];
};

const timestamp = (value: string): Candidate[] =>
	parseMoments(value)
		.filter(valid)
		.filter(
			({ hour, minute, second }) => (hour ?? 0) < 24 && (minute ?? 0) < 60 && (second ?? 0) < 60
		)
		.map((moment) => ({
			detector: 'timestamp',
			kind: 'timestamp',
			confidence: LOW,
			value,
			span: span(moment)
		}));

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

const ip = (value: string): Candidate[] => {
	const v4 = IPV4.exec(value);
	if (v4) {
		const [, ...parts] = v4;
		const [mask] = parts.splice(4);
		if (parts.some((part) => Number(part) > 255) || (mask !== undefined && Number(mask) > 32))
			return [];
		return [{ detector: 'ip', kind: 'ip', confidence: MEDIUM, value }];
	}
	const [address, mask, ...rest] = value.split('/');
	if (rest.length > 0 || !address.includes(':') || !/^[0-9a-f:.]+$/i.test(address)) return [];
	if (mask !== undefined && !(/^\d{1,3}$/.test(mask) && Number(mask) <= 128)) return [];
	try {
		new URL(`http://[${address}]/`);
	} catch {
		return [];
	}
	return [{ detector: 'ip', kind: 'ip', confidence: MEDIUM, value: value.toLowerCase() }];
};

const DATE_SHAPED = /^(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})$/;

const phone = (value: string): Candidate[] => {
	if (!/^\+?[\d\s().-]+$/.test(value) || DATE_SHAPED.test(value)) return [];
	const digits = value.replace(/\D/g, '');
	if (digits.length < 7 || digits.length > 15) return [];
	const formatted = value !== digits;
	if (!formatted && digits.length < 10) return [];
	return [
		{
			detector: 'phone',
			kind: 'phone',
			confidence: LOW,
			value,
			texts: unique([value, digits, value.startsWith('+') ? `+${digits}` : undefined])
		}
	];
};

const text = (value: string, raw: string): Candidate[] =>
	value.length > MAX_TEXT_LENGTH
		? []
		: [{ detector: 'text', kind: 'text', confidence: LOW, value, texts: unique([value, raw]) }];

const decode = (part: string) => {
	try {
		return decodeURIComponent(part.replaceAll('+', ' '));
	} catch {
		return part;
	}
};

const ID_LIKE = new Set<Detector>(['uuid', 'email', 'integer']);
const ID_LIKE_WITH_DIGITS = new Set<Detector>(['prefixed', 'text']);

const url = (value: string): Interpretation | undefined => {
	if (!/^https?:\/\//i.test(value)) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return undefined;
	}
	const [hashPath, hashQuery] = parsed.hash.slice(1).split('?');
	const segments = [...parsed.pathname.split('/'), ...(hashPath ?? '').split('/')]
		.map(decode)
		.filter((segment) => segment !== '');
	const params = [...parsed.searchParams, ...new URLSearchParams(hashQuery ?? '')];
	const candidates: Candidate[] = [];
	const hints: Hint[] = [];
	const extract = (part: string) => {
		const detected = detectParts(part, part, false).filter(
			({ detector }) =>
				ID_LIKE.has(detector) || (ID_LIKE_WITH_DIGITS.has(detector) && /\d/.test(part))
		);
		const found = detected.some((interpretation) => !isText(interpretation))
			? detected.filter((interpretation) => !isText(interpretation))
			: detected;
		for (const { candidates: extracted } of found) {
			for (const candidate of extracted) {
				candidates.push({
					...candidate,
					confidence: Math.min(candidate.confidence, MEDIUM),
					via: 'url'
				});
			}
		}
		return found.length > 0;
	};
	segments.forEach((segment, index) => {
		if (extract(segment) && index > 0) hints.push({ word: segments[index - 1], kind: 'exact' });
	});
	for (const [key, part] of params) {
		if (extract(part)) hints.push({ word: key.replace(/_?id$/i, ''), kind: 'exact' });
	}
	const seen = new Set<string>();
	const deduplicated = candidates.filter((candidate) => {
		const key = candidateKey(candidate);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return deduplicated.length > 0
		? { detector: 'url', candidates: deduplicated, hints: hints.filter(({ word }) => word !== '') }
		: undefined;
};

const detectParts = (value: string, raw: string, hinted: boolean): Interpretation[] => {
	if (value === '') return [];
	const found: Interpretation[] = [];
	const add = (detector: Detector, candidates: Candidate[]) => {
		if (candidates.length > 0) found.push({ detector, candidates, hints: [] });
	};
	add('uuid', uuid(value));
	add('email', email(value));
	const prefix = prefixed(value, raw);
	if (prefix) found.push(prefix);
	add('integer', integer(value, hinted));
	add('timestamp', timestamp(value));
	add('ip', ip(value));
	if (!found.some(({ detector }) => ['uuid', 'timestamp', 'ip'].includes(detector))) {
		add('phone', phone(value));
	}
	add('text', text(value, raw));
	return found;
};

export const detect = (value: string, raw: string, hinted: boolean): Interpretation[] => {
	const fromUrl = url(value);
	if (fromUrl) return [fromUrl, ...detectParts(value, raw, hinted).filter(isText)];
	return detectParts(value, raw, hinted);
};

const isText = ({ detector }: Interpretation) => detector === 'text';

const COVERS_TEXT = new Set<Detector>(['uuid', 'email', 'url', 'prefixed', 'integer']);

export const select = (interpretations: Interpretation[], detector: Detector | null) => {
	const chosen =
		detector === null
			? interpretations.some(({ detector }) => COVERS_TEXT.has(detector))
				? interpretations.filter((interpretation) => !isText(interpretation))
				: interpretations
			: interpretations.filter((interpretation) => interpretation.detector === detector);
	const best = new Map<string, Candidate>();
	for (const candidate of chosen.flatMap(({ candidates }) => candidates)) {
		const key = candidateKey(candidate);
		const existing = best.get(key);
		if (!existing || existing.confidence < candidate.confidence) best.set(key, candidate);
	}
	return { candidates: [...best.values()], hints: chosen.flatMap(({ hints }) => hints) };
};
