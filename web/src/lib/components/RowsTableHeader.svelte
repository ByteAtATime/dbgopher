<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { Column } from '#lib/protocol/bindings/Column.ts';
	import type { Sort } from '#lib/protocol/bindings/Sort.ts';

	export const [getSort, setSort] = createContext<() => Sort | undefined>();
	export const [getColumns, setColumns] = createContext<() => Column[]>();
</script>

<script lang="ts">
	import type { IHeaderCellProps } from '@svar-ui/svelte-grid';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { getOutgoingLinks } from './RowsTableOutgoing.svelte';

	let { cell, column }: IHeaderCellProps = $props();

	const sort = getSort();
	const columns = getColumns();
	const outgoing = getOutgoingLinks();

	const type = $derived(columns()[Number(column.id) - 1]?.typeName);

	const reference = $derived(
		outgoing.references().find(({ referencedColumns }) => referencedColumns[0] === cell.text)
	);

	const direction = $derived(sort()?.column === cell.text ? sort()?.direction : undefined);
</script>

<div class="flex min-w-0 flex-1 items-center gap-1">
	<span class="w-full truncate">
		{cell.text}
		{#if type}
			<span class="font-mono text-xs text-muted-foreground/70">{type}</span>
		{/if}
		{#if reference}
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<span {...props} class="inline-flex align-middle text-muted-foreground/70">
							<ArrowUpRightIcon class="size-3.5" />
						</span>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content class="font-mono">
					{reference.label}.{reference.columns.join(', ')}
				</Tooltip.Content>
			</Tooltip.Root>
		{/if}
	</span>
	{#if direction === 'asc'}
		<ChevronUp class="size-3.5 shrink-0 text-foreground" />
	{:else if direction === 'desc'}
		<ChevronDown class="size-3.5 shrink-0 text-foreground" />
	{:else}
		<ChevronsUpDown class="size-3.5 shrink-0 opacity-0 in-[.wx-cell:hover]:opacity-100" />
	{/if}
</div>
