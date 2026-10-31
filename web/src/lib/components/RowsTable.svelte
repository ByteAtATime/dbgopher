<script lang="ts">
	import { Grid, Willow, type IApi, type IColumnConfig } from '@svar-ui/svelte-grid';
	import BugIcon from '@lucide/svelte/icons/bug';
	import type { Sort } from '#lib/protocol/bindings/Sort.ts';
	import type { Browse } from '#lib/protocol/client.ts';
	import RowsTableCell, { setRows } from './RowsTableCell.svelte';
	import RowsTableHeader, { setSort } from './RowsTableHeader.svelte';

	type Props = {
		columns: string[];
		rows?: Browse;
		sort?: Sort;
		onsort: (sort: Sort | undefined) => void;
	};

	const COLUMN_WIDTH = 250;
	const SKELETON_ROWS = 8;

	let { columns, rows, sort, onsort }: Props = $props();

	setRows(() => rows);
	setSort(() => sort);

	const headers = $derived(rows?.columns.map((column) => column.name) ?? columns);

	const gridColumns = $derived<IColumnConfig[]>(
		headers.map((header, index) => ({
			id: index,
			header: { text: header, cell: RowsTableHeader },
			width: COLUMN_WIDTH,
			resize: true,
			sort: true,
			cell: RowsTableCell
		}))
	);

	const toggle = (column: string) =>
		onsort(
			sort?.column !== column
				? { column, direction: 'asc' }
				: sort.direction === 'asc'
					? { column, direction: 'desc' }
					: undefined
		);

	let api: IApi | undefined;

	const init = (grid: IApi) => {
		api = grid;
		grid.intercept('sort-rows', ({ key }) => {
			toggle(headers[Number(key)]);
			return false;
		});
	};

	const focus = (event: MouseEvent) => {
		const cell =
			event.target instanceof Element
				? event.target.closest<HTMLElement>('.wx-body .wx-cell')
				: null;
		if (!cell) return;
		api?.exec('focus-cell', {
			row: Number(cell.dataset.rowId),
			column: Number(cell.dataset.colId),
			eventSource: 'click'
		});
	};

	const data = $derived(
		Array.from({ length: rows?.rows.length ?? SKELETON_ROWS }, (_, index) => ({ id: index + 1 }))
	);
</script>

<div
	class={[
		'rows-grid relative h-full',
		!rows && '[&_.wx-body]:animate-pulse [&_.wx-body]:mask-b-from-0%'
	]}
	onmousedown={focus}
>
	<Willow fonts={false}>
		<Grid
			{data}
			columns={gridColumns}
			select={false}
			{init}
			sizes={{ rowHeight: 33, headerHeight: 40, columnWidth: COLUMN_WIDTH }}
		/>
	</Willow>
	{#if rows?.rows.length === 0}
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
		--wx-font-size: var(--text-xs);
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

	.rows-grid :global(.wx-table-box) {
		box-sizing: border-box;
	}

	.rows-grid :global(.wx-scroll) {
		scrollbar-width: thin;
		scrollbar-color: var(--muted-foreground) transparent;
	}

	.rows-grid :global(.wx-header .wx-cell) {
		color: var(--muted-foreground);
		cursor: pointer;
	}

	.rows-grid :global(.wx-body .wx-cell) {
		font-family: var(--font-mono);
	}
</style>
