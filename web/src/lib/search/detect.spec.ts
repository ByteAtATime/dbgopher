import { describe, expect, it } from 'vitest';
import { detect, normalize, type Candidate, type Match } from './detect';

const paste = (match: Match, scope: string | null = null): Candidate => ({
	...match,
	source: 'paste',
	scope
});

const fromUrl = (match: Match, scope: string | null = null): Candidate => ({
	...match,
	source: 'url',
	scope
});

describe('normalize', () => {
	it.each([
		['`ord_123`', 'ord_123'],
		['"ord_123".', 'ord_123'],
		['\u201Cord_123\u201D', 'ord_123'],
		['\u00A0 1234\u200B ', '1234'],
		["'#1234'),", '#1234'],
		['f(x)', 'f(x)']
	])('normalizes %j to %j', (input, normalized) => {
		expect(normalize(input).normalized).toBe(normalized);
	});

	it('keeps the raw first line and flags further lines', () => {
		expect(normalize('\n "ord_1".\nord_2\n')).toEqual({
			raw: '"ord_1".',
			normalized: 'ord_1',
			multiline: true
		});
	});
});

describe('detect', () => {
	it('canonicalizes uuids in any accepted form', () => {
		const uuid = paste({
			kind: 'uuid',
			value: '550e8400-e29b-41d4-a716-446655440000',
			confidence: 'high'
		});
		for (const input of [
			'550E8400E29B41D4A716446655440000',
			'550e8400-e29b-41d4-a716-446655440000',
			'{550E8400-E29B-41D4-A716-446655440000}',
			'urn:uuid:550e8400-e29b-41d4-a716-446655440000'
		]) {
			expect(detect(input).candidates).toEqual([uuid]);
		}
	});

	it('rejects partially hyphenated uuids', () => {
		expect(detect('550e8400-e29b41d4a716446655440000').candidates).not.toContainEqual(
			expect.objectContaining({ kind: 'uuid' })
		);
	});

	it.each(['Jane@Acme.com', 'mailto:Jane@Acme.com?subject=hi', 'Jane Doe <Jane@Acme.com>'])(
		'detects the email in %j along with its lowercase form',
		(input) => {
			expect(detect(input).candidates).toEqual([
				paste({ kind: 'email', value: 'Jane@Acme.com', confidence: 'high' }),
				paste({ kind: 'email', value: 'jane@acme.com', confidence: 'high' })
			]);
		}
	);

	it('treats a bare integer as low confidence', () => {
		expect(detect('42').candidates).toEqual([
			paste({ kind: 'integer', value: 42n, confidence: 'low' })
		]);
	});

	it('strips hidden characters before detecting', () => {
		expect(detect('#1234\u200B').candidates).toEqual([
			paste({ kind: 'integer', value: 1234n, confidence: 'low' })
		]);
	});

	it('keeps integers that only fit int8', () => {
		expect(detect('99999999999').candidates).toEqual([
			paste({ kind: 'integer', value: 99999999999n, confidence: 'low' })
		]);
	});

	it('falls back to text for integers beyond int8', () => {
		expect(detect('9223372036854775808').candidates).toEqual([
			paste({ kind: 'text', value: '9223372036854775808', confidence: 'low' })
		]);
	});

	it('prefers the text form of leading zeros', () => {
		expect(detect('00042').candidates).toEqual([
			paste({ kind: 'text', value: '00042', confidence: 'medium' }),
			paste({ kind: 'integer', value: 42n, confidence: 'low' })
		]);
	});

	it.each([
		['ord_8f3k', { kind: 'text', value: '8f3k', confidence: 'medium' }],
		['INV-0042', { kind: 'text', value: '0042', confidence: 'medium' }],
		['ord_123', { kind: 'integer', value: 123n, confidence: 'medium' }]
	] as const)('splits the prefixed id %j', (input, suffix) => {
		expect(detect(input).candidates).toContainEqual(
			paste({ kind: 'text', value: input, confidence: 'medium' })
		);
		expect(detect(input).candidates).toContainEqual(paste(suffix));
	});

	it('also tries the raw paste as text when normalization changed it', () => {
		expect(detect('"ord_123".').candidates).toContainEqual(
			paste({ kind: 'text', value: '"ord_123".', confidence: 'low' })
		);
	});

	it.each([
		['order 1234', 'order'],
		['Orders: #1234', 'orders']
	])('reads %j as a scoped integer', (input, scope) => {
		expect(detect(input).candidates).toEqual([
			paste({ kind: 'integer', value: 1234n, confidence: 'medium' }, scope)
		]);
	});

	it('scopes emails by a leading word', () => {
		expect(detect('user: x@y.com').candidates).toEqual([
			paste({ kind: 'email', value: 'x@y.com', confidence: 'high' }, 'user')
		]);
	});

	it('keeps unrecognized phrases as text', () => {
		expect(detect('hello world').candidates).toEqual([
			paste({ kind: 'text', value: 'hello world', confidence: 'low' })
		]);
	});

	it('extracts ids and scope hints from admin urls', () => {
		const { candidates } = detect('https://admin.x.com/orders/1234?tab=items');
		expect(candidates).toContainEqual(
			fromUrl({ kind: 'integer', value: 1234n, confidence: 'medium' }, 'orders')
		);
		expect(candidates).toContainEqual(fromUrl({ kind: 'text', value: 'items', confidence: 'low' }));
	});

	it('caps url parts at medium confidence', () => {
		expect(
			detect('https://x.com/users/550e8400-e29b-41d4-a716-446655440000').candidates
		).toContainEqual(
			fromUrl(
				{ kind: 'uuid', value: '550e8400-e29b-41d4-a716-446655440000', confidence: 'medium' },
				'users'
			)
		);
	});

	it('uses only the first line of a multi-line paste', () => {
		expect(detect('1\n2\n3')).toEqual({
			multiline: true,
			candidates: [paste({ kind: 'integer', value: 1n, confidence: 'low' })]
		});
	});

	it('detects nothing in an empty paste', () => {
		expect(detect(' \u200B\n')).toEqual({ multiline: false, candidates: [] });
	});
});
