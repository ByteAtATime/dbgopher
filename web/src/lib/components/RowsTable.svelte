<script lang="ts">
	import {
		Grid,
		Willow,
		type IApi,
		type IColumn,
		type IColumnConfig,
		type IRow
	} from '@svar-ui/svelte-grid';
	import BugIcon from '@lucide/svelte/icons/bug';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import type { Column } from '#lib/protocol/bindings/Column.ts';
	import type { Filter } from '#lib/protocol/bindings/Filter.ts';
	import type { Sort } from '#lib/protocol/bindings/Sort.ts';
	import type { Browse } from '#lib/protocol/client.ts';
	import type { Reference } from '#lib/references.ts';
	import RowsTableCell, { setRows } from './RowsTableCell.svelte';
	import RowsTableHeader, { setColumns, setSort } from './RowsTableHeader.svelte';
	import RowsTableReference, { setReferenceLinks } from './RowsTableReference.svelte';
	import RowsTableReferenceHeader from './RowsTableReferenceHeader.svelte';

	type Props = {
		columns: Column[];
		rows?: Browse;
		sort?: Sort;
		loading?: boolean;
		references?: Reference[];
		onsort: (sort: Sort | undefined) => void;
		onprefetch: (reference: Reference, filter: Filter[]) => void;
	};

	const COLUMN_WIDTH = 250;
	const REFERENCE_WIDTH = 160;
	const SKELETON_ROWS = 8;

	type CellPosition = { row: number; column: number };

	let {
		columns,
		rows,
		sort,
		loading = false,
		references = [],
		onsort,
		onprefetch
	}: Props = $props();

	setRows(() => rows);
	setSort(() => sort);
	setColumns(() => rows?.columns ?? columns);

	const headers = $derived((rows?.columns ?? columns).map((column) => column.name));

	setReferenceLinks({
		references: () => references,
		columns: () => headers.length,
		onprefetch: (reference, filter) => onprefetch(reference, filter)
	});

	const widths = new Map<string, number>();
	const referenceWidthKey = (reference: Reference) => `\0${reference.label}`;

	const gridColumns = $derived<IColumnConfig[]>([
		...headers.map((header, index) => ({
			id: index + 1,
			header: { text: header, cell: RowsTableHeader },
			width: widths.get(header) ?? COLUMN_WIDTH,
			resize: true,
			sort: true,
			cell: RowsTableCell
		})),
		...references.map((reference, index) => ({
			id: headers.length + index + 1,
			header: { text: reference.label, cell: RowsTableReferenceHeader },
			width: widths.get(referenceWidthKey(reference)) ?? REFERENCE_WIDTH,
			resize: true,
			cell: RowsTableReference
		}))
	]);

	const toggle = (column: string) =>
		onsort(
			sort?.column !== column
				? { column, direction: 'asc' }
				: sort.direction === 'asc'
					? { column, direction: 'desc' }
					: undefined
		);

	let api: IApi | undefined;
	let anchor = $state.raw<CellPosition>();
	let head = $state.raw<CellPosition>();
	let dragging = false;

	const init = (grid: IApi) => {
		api = grid;
		grid.intercept('sort-rows', ({ key }) => {
			toggle(headers[Number(key) - 1]);
			return false;
		});
		grid.on('focus-cell', ({ row, column }) => {
			anchor = head =
				row === undefined || column === undefined
					? undefined
					: { row: Number(row), column: Number(column) };
		});
		grid.on('resize-column', ({ id, width }) => {
			if (width === undefined) return;
			const index = Number(id) - 1;
			const reference = references[index - headers.length];
			widths.set(reference ? referenceWidthKey(reference) : headers[index], width);
		});
	};

	const locate = (event: MouseEvent): CellPosition | undefined => {
		const cell =
			event.target instanceof Element
				? event.target.closest<HTMLElement>('.wx-body .wx-cell')
				: null;
		return cell
			? { row: Number(cell.dataset.rowId), column: Number(cell.dataset.colId) }
			: undefined;
	};

	const press = (event: MouseEvent) => {
		if (followsLink(event)) return;
		const cell = locate(event);
		if (!cell) return;
		dragging = true;
		if (event.shiftKey && anchor) {
			event.preventDefault();
			head = cell;
		} else {
			api?.exec('focus-cell', { ...cell, eventSource: 'click' });
		}
	};

	const extend = (event: MouseEvent) => {
		if (dragging && anchor) head = locate(event) ?? head;
	};

	const followsLink = (event: MouseEvent) =>
		event.target instanceof Element &&
		event.target.closest('a') !== null &&
		!(event.shiftKey && anchor);

	const blockGridClick = (event: MouseEvent) => {
		if (!(event.target instanceof Element) || !event.target.closest('.wx-body')) return;
		if (followsLink(event)) return;
		event.stopPropagation();
		if (event.target.closest('a')) event.preventDefault();
	};

	const bounds = $derived(
		anchor &&
			head && {
				top: Math.min(anchor.row, head.row),
				bottom: Math.max(anchor.row, head.row),
				left: Math.min(anchor.column, head.column),
				right: Math.max(anchor.column, head.column)
			}
	);

	const cellStyle = (row: IRow, column: IColumn) => {
		const r = Number(row.id);
		const c = Number(column.id);
		if (!bounds || r < bounds.top || r > bounds.bottom || c < bounds.left || c > bounds.right) {
			return '';
		}
		return [
			'selected',
			r === bounds.top && 'selected-top',
			r === bounds.bottom && 'selected-bottom',
			c === bounds.left && 'selected-left',
			c === bounds.right && 'selected-right'
		]
			.filter(Boolean)
			.join(' ');
	};

	const data = $derived(
		Array.from({ length: rows?.rows.length ?? SKELETON_ROWS }, (_, index) => ({ id: index + 1 }))
	);
</script>

<svelte:window onmouseup={() => (dragging = false)} />

<div
	class={[
		'rows-grid relative h-full',
		!rows && '[&_.wx-body]:animate-pulse [&_.wx-body]:mask-b-from-0%'
	]}
	onmousedown={press}
	onpointerover={extend}
	onclickcapture={blockGridClick}
>
	<Willow fonts={false}>
		<Grid
			{data}
			columns={gridColumns}
			select={false}
			{cellStyle}
			{init}
			sizes={{ rowHeight: 33, headerHeight: 40, columnWidth: COLUMN_WIDTH }}
		/>
	</Willow>
	{#if rows && loading}
		<div
			class="absolute inset-x-0 top-10 bottom-0 z-10 flex items-center justify-center bg-background/60"
		>
			<LoaderCircleIcon class="size-8 animate-spin text-muted-foreground" />
		</div>
	{:else if rows?.rows.length === 0}
		<div
			class="pointer-events-none absolute inset-x-0 top-10 bottom-0 flex flex-col items-center justify-center gap-2 text-muted-foreground"
		>
			<BugIcon class="size-8" />
			<p class="font-medium">No rows to be found here!</p>
			<p class="text-sm italic">*cricket noises*</p>
		</div>
	{/if}
</div>

<style>
	.rows-grid :global(.wx-willow-theme) {
		--wx-font-family: var(--font-sans);
		--wx-font-size: var(--text-sm);
		--wx-line-height: 16px;
		--wx-color-font: var(--foreground);
		--wx-color-font-alt: var(--muted-foreground);
		--wx-color-primary: var(--primary);
		--wx-background: var(--background);
		--wx-background-alt: var(--muted);
		--wx-background-hover: var(--accent);
		--wx-border-color: var(--border);
		--wx-border: 1px solid var(--border);
		--wx-table-border: 1px solid var(--border);
		--wx-table-header-background: var(--background);
		--wx-header-font-weight: 500;
		--wx-table-select-background: var(--accent);
		--wx-table-fixed-column-border: 1px solid var(--border);
	}

	.rows-grid :global(.wx-grid .wx-table-box) {
		box-sizing: border-box;
		width: 100% !important;
		border-left: none;
		border-bottom: none;
	}

	.rows-grid :global(.wx-body .wx-row:last-child) {
		border-bottom: var(--wx-table-cell-border);
	}

	.rows-grid :global(.wx-scroll) {
		scrollbar-width: thin;
		scrollbar-color: var(--muted-foreground) transparent;
	}

	.rows-grid :global(.wx-header .wx-cell) {
		color: var(--muted-foreground);
		cursor: pointer;
	}

	.rows-grid :global(.wx-header .wx-cell:focus) {
		outline: none;
	}

	.rows-grid :global(.wx-body .wx-cell) {
		font-family: var(--font-mono);
		user-select: none;
		overflow: visible;
	}

	.rows-grid :global(.wx-body .wx-cell > *) {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.rows-grid :global(.wx-body .wx-cell:focus) {
		outline: none;
	}

	.rows-grid :global(.wx-body .wx-row:has(+ .wx-row:hover)) {
		border-bottom-color: var(--muted-foreground);
	}

	.rows-grid :global(.wx-body .wx-row:hover) {
		--wx-table-cell-border: 1px solid var(--muted-foreground);

		:global(.wx-cell) {
			background: var(--muted);
		}
	}

	.rows-grid :global(.wx-body .wx-row .wx-cell.selected) {
		position: relative;
		/* TODO: probably a bad idea? */
		background: color-mix(var(--primary-soft), var(--background) 50%);
	}

	.rows-grid :global(.wx-body .wx-cell.selected::after) {
		content: '';
		position: absolute;
		inset: 0;
		pointer-events: none;
		border: 0 solid var(--wx-color-primary);
	}

	.rows-grid :global(.wx-body .wx-cell.selected:not(.selected-bottom)::after) {
		bottom: -1px;
	}

	.rows-grid :global(.wx-body .wx-cell.selected:not(.selected-right)::after) {
		right: -1px;
	}

	.rows-grid :global(.wx-body .wx-cell.selected-top::after) {
		border-top-width: 1px;
	}

	.rows-grid :global(.wx-body .wx-cell.selected-bottom::after) {
		border-bottom-width: 1px;
	}

	.rows-grid :global(.wx-body .wx-cell.selected-left::after) {
		border-left-width: 1px;
	}

	.rows-grid :global(.wx-body .wx-cell.selected-right::after) {
		border-right-width: 1px;
	}

	.rows-grid :global(.wx-cell:first-child) {
		border-left: var(--wx-table-cell-border);
	}

	.rows-grid :global(.wx-cell:last-child) {
		border-right: var(--wx-table-cell-border);
	}
</style>
