import { describe, expect, it } from 'vitest';
import { selectedText, toHtml, toTsv } from './clipboard';
import type { Browse } from './protocol/client';

const text = (value: string) => ({ kind: 'text' as const, text: value });

const browse: Browse = {
	type: 'browse',
	columns: [],
	rows: [
		[text('a1'), text('b1'), text('c1')],
		[text('a2'), null, { kind: 'binary', bytes: 12 }],
		[text('a3'), text('b3'), text('c3')]
	]
};

describe('selectedText', () => {
	it('slices the inclusive range', () => {
		expect(selectedText(browse, { top: 0, bottom: 1, left: 1, right: 2 })).toEqual([
			['b1', 'c1'],
			['', '']
		]);
	});

	it('selects a single cell', () => {
		expect(selectedText(browse, { top: 2, bottom: 2, left: 2, right: 2 })).toEqual([['c3']]);
	});
});

describe('toTsv', () => {
	it('joins cells with tabs and rows with newlines', () => {
		expect(
			toTsv([
				['a', 'b'],
				['c', 'd']
			])
		).toBe('a\tb\nc\td');
	});

	it('quotes fields containing tabs, newlines or quotes', () => {
		expect(toTsv([['x\ty', 'line\nbreak', 'say "hi"', 'plain']])).toBe(
			'"x\ty"\t"line\nbreak"\t"say ""hi"""\tplain'
		);
	});
});

describe('toHtml', () => {
	it('builds an escaped table', () => {
		expect(
			toHtml([
				['<b>&', 'a\nb'],
				['', '"q"']
			])
		).toBe(
			'<table style="border-collapse:collapse"><tr><td style="border:1px solid #000">&lt;b&gt;&amp;</td><td style="border:1px solid #000">a<br>b</td></tr><tr><td style="border:1px solid #000"></td><td style="border:1px solid #000">&quot;q&quot;</td></tr></table>'
		);
	});
});
