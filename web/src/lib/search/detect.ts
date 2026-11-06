export type Confidence = 'low' | 'medium' | 'high';

export type Match = { confidence: Confidence } & (
	| { kind: 'uuid'; value: string }
	| { kind: 'email'; value: string }
	| { kind: 'integer'; value: bigint }
	| { kind: 'text'; value: string }
);

export type Candidate = Match & { source: 'paste' | 'url'; scope: string | null };

export type Detection = { multiline: boolean; candidates: Candidate[] };

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const INT8_MAX = 9223372036854775807n;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
const DOUBLE_QUOTES = /[\u201C-\u201F]/g;
const SINGLE_QUOTES = /[\u2018-\u201B]/g;
const QUOTES = ['"', "'", '`'];

const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const ANGLE_ADDRESS = /<([^<>]+)>$/;
const PREFIXED = /^#?[A-Za-z][A-Za-z0-9]*[_-]([A-Za-z0-9]+)$/;
const INTEGER = /^#?(\d+)$/;
const DIGITS = /^\d+$/;
const URL_SCHEME = /^https?:\/\//i;
const SCOPED = /^([A-Za-z][A-Za-z0-9_]*)(?::\s*|\s+)(\S+)$/;
const SCOPE_WORD = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const count = (text: string, char: string) => text.split(char).length - 1;

const stripTrailing = (text: string): string => {
	const last = text.at(-1);
	const strays = last === ')' && count(text, '(') < count(text, ')');
	if (last === '.' || last === ',' || last === ';' || strays)
		return stripTrailing(text.slice(0, -1).trimEnd());
	return text;
};

const unwrap = (text: string): string => {
	const quote = QUOTES.find((q) => text.length >= 2 && text.startsWith(q) && text.endsWith(q));
	return quote ? unwrap(text.slice(1, -1).trim()) : text;
};

const clean = (text: string): string => {
	const next = unwrap(stripTrailing(text));
	return next === text ? text : clean(next);
};

export const normalize = (input: string) => {
	const lines = input
		.replace(ZERO_WIDTH, '')
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const raw = lines[0] ?? '';
	return {
		raw,
		normalized: clean(raw.replace(DOUBLE_QUOTES, '"').replace(SINGLE_QUOTES, "'")),
		multiline: lines.length > 1
	};
};

const uuid = (text: string): Match[] => {
	const bare = text.replace(/^urn:uuid:/i, '');
	const body = bare.startsWith('{') && bare.endsWith('}') ? bare.slice(1, -1) : bare;
	if (!UUID.test(body)) return [];
	const hex = body.replaceAll('-', '').toLowerCase();
	const value = [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20)
	];
	return [{ kind: 'uuid', value: value.join('-'), confidence: 'high' }];
};

const email = (text: string): Match[] => {
	const address = ANGLE_ADDRESS.exec(text)?.[1] ?? text.replace(/^mailto:/i, '').split('?')[0];
	if (!EMAIL.test(address)) return [];
	const lower = address.toLowerCase();
	const forms = lower === address ? [address] : [address, lower];
	return forms.map((value): Match => ({ kind: 'email', value, confidence: 'high' }));
};

const integer = (digits: string, confidence: Confidence): Match[] => {
	const value = BigInt(digits);
	if (value > INT8_MAX) return [];
	if (digits.length > 1 && digits.startsWith('0'))
		return [
			{ kind: 'text', value: digits, confidence: 'medium' },
			{ kind: 'integer', value, confidence: 'low' }
		];
	return [{ kind: 'integer', value, confidence }];
};

const prefixed = (text: string): Match[] => {
	const suffix = PREFIXED.exec(text)?.[1];
	if (!suffix) return [];
	const rest: Match[] = DIGITS.test(suffix)
		? integer(suffix, 'medium')
		: [{ kind: 'text', value: suffix, confidence: 'medium' }];
	return [{ kind: 'text', value: text, confidence: 'medium' }, ...rest];
};

const token = (text: string): Match[] => {
	const digits = INTEGER.exec(text)?.[1];
	return [
		...uuid(text),
		...email(text),
		...prefixed(text),
		...(digits ? integer(digits, 'low') : [])
	];
};

const scoped = (match: Match, source: Candidate['source'], scope: string | null): Candidate => {
	const confidence =
		scope && match.kind === 'integer' && match.confidence === 'low' ? 'medium' : match.confidence;
	return { ...match, confidence, source, scope };
};

const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
};

const url = (text: string): Candidate[] => {
	if (!URL_SCHEME.test(text) || !URL.canParse(text)) return [];
	const { pathname, searchParams } = new URL(text);
	const segments = pathname.split('/').filter(Boolean).map(decode);
	const parts = [
		...segments.map((part, i) => {
			const previous = segments[i - 1];
			return { part, scope: previous && SCOPE_WORD.test(previous) ? previous.toLowerCase() : null };
		}),
		...[...searchParams.values()].filter(Boolean).map((part) => ({ part, scope: null }))
	];
	return parts.flatMap(({ part, scope }) => {
		const found = token(part);
		const matches: Match[] =
			found.length > 0 ? found : [{ kind: 'text', value: part, confidence: 'low' }];
		return matches.map((match) => {
			const candidate = scoped(match, 'url', scope);
			return candidate.confidence === 'high' ? { ...candidate, confidence: 'medium' } : candidate;
		});
	});
};

const specific = (text: string): Candidate[] => {
	const found = url(text);
	return found.length > 0 ? found : token(text).map((match) => scoped(match, 'paste', null));
};

const candidates = (raw: string, normalized: string): Candidate[] => {
	if (normalized === '') return [];
	const direct = specific(normalized);
	const fallback = [normalized, ...(raw === normalized ? [] : [raw])].map((value): Candidate => ({
		kind: 'text',
		value,
		confidence: 'low',
		source: 'paste',
		scope: null
	}));
	if (direct.length > 0) return [...direct, ...fallback.slice(1)];
	const [, scope, rest] = SCOPED.exec(normalized) ?? [];
	if (scope) {
		const found = specific(clean(rest)).map((candidate) =>
			scoped(candidate, candidate.source, candidate.scope ?? scope.toLowerCase())
		);
		if (found.length > 0) return found;
	}
	return fallback;
};

const dedupe = (all: Candidate[]) => {
	const unique = new Map<string, Candidate>();
	for (const candidate of all) {
		const key = `${candidate.kind}:${candidate.value}`;
		const existing = unique.get(key);
		if (!existing || RANK[candidate.confidence] > RANK[existing.confidence])
			unique.set(key, candidate);
	}
	return [...unique.values()];
};

export const detect = (input: string): Detection => {
	const { raw, normalized, multiline } = normalize(input);
	return { multiline, candidates: dedupe(candidates(raw, normalized)) };
};
