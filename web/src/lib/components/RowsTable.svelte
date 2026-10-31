<script lang="ts">
	import { Grid, Willow, type IColumnConfig } from '@svar-ui/svelte-grid';
	import BugIcon from '@lucide/svelte/icons/bug';
	import type { Browse } from '#lib/protocol/client.ts';
	import RowsTableCell, { setRows } from './RowsTableCell.svelte';

	type Props = { columns: string[]; rows?: Browse };

	const COLUMN_WIDTH = 250;
	const SKELETON_ROWS = 8;

	let { columns, rows }: Props = $props();

	setRows(() => rows);

	const headers = $derived(rows?.columns.map((column) => column.name) ?? columns);

	const gridColumns = $derived<IColumnConfig[]>(
		headers.map((header, index) => ({
			id: index,
			header,
			width: COLUMN_WIDTH,
			resize: true,
			cell: RowsTableCell
		}))
	);

	const data = $derived(
		Array.from({ length: rows?.rows.length ?? SKELETON_ROWS }, (_, index) => ({ id: index + 1 }))
	);
</script>

<div
	class={[
		'rows-grid relative h-full',
		!rows && '[&_.wx-body]:animate-pulse [&_.wx-body]:mask-b-from-0%'
	]}
>
	<Willow fonts={false}>
		<Grid
			{data}
			columns={gridColumns}
			select={false}
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
	}

	.rows-grid :global(.wx-body .wx-cell) {
		font-family: var(--font-mono);
	}
</style>
