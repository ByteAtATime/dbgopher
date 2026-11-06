import type { Browse } from './protocol/client';

export type CellRange = { top: number; bottom: number; left: number; right: number };

type Value = Browse['rows'][number][number];

const cellText = (value: Value | undefined) => (value?.kind === 'text' ? value.text : '');

export const selectedText = (rows: Browse, range: CellRange) =>
	rows.rows
		.slice(range.top, range.bottom + 1)
		.map((row) => row.slice(range.left, range.right + 1).map(cellText));

const tsvField = (text: string) =>
	/[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

export const toTsv = (grid: string[][]) =>
	grid.map((row) => row.map(tsvField).join('\t')).join('\n');

const escapeHtml = (text: string) =>
	text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll(/\r?\n/g, '<br>');

const CELL_STYLE = 'border:1px solid #000';

export const toHtml = (grid: string[][]) =>
	`<table style="border-collapse:collapse">${grid
		.map(
			(row) =>
				`<tr>${row.map((text) => `<td style="${CELL_STYLE}">${escapeHtml(text)}</td>`).join('')}</tr>`
		)
		.join('')}</table>`;
