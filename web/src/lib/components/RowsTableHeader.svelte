<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { Sort } from '#lib/protocol/bindings/Sort.ts';

	export const [getSort, setSort] = createContext<() => Sort | undefined>();
</script>

<script lang="ts">
	import type { IHeaderCellProps } from '@svar-ui/svelte-grid';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';

	let { cell }: IHeaderCellProps = $props();

	const sort = getSort();

	const direction = $derived(sort()?.column === cell.text ? sort()?.direction : undefined);
</script>

<div class="flex min-w-0 flex-1 items-center gap-1">
	<span class="w-full truncate">{cell.text}</span>
	{#if direction === 'asc'}
		<ChevronUp class="size-3.5 shrink-0 text-foreground" />
	{:else if direction === 'desc'}
		<ChevronDown class="size-3.5 shrink-0 text-foreground" />
	{:else}
		<ChevronsUpDown class="size-3.5 shrink-0 opacity-0 in-[.wx-cell:hover]:opacity-100" />
	{/if}
</div>
