<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { Browse } from '#lib/protocol/client.ts';

	export const [getRows, setRows] = createContext<() => Browse | undefined>();
</script>

<script lang="ts">
	import type { ICellProps } from '@svar-ui/svelte-grid';
	import { referenceFilter } from '#lib/references.ts';
	import CellValue from './CellValue.svelte';
	import RowsTableOutgoing, { getOutgoingLinks } from './RowsTableOutgoing.svelte';

	let { row, column }: ICellProps = $props();

	const rows = getRows();
	const outgoing = getOutgoingLinks();

	const loaded = $derived(rows());
	const index = $derived(Number(row.id) - 1);
	const name = $derived(loaded?.columns[Number(column.id) - 1]?.name);
	const value = $derived(loaded?.rows[index]?.[Number(column.id) - 1]);
	const reference = $derived(
		outgoing.references().find(({ referencedColumns }) => referencedColumns[0] === name)
	);
	const filter = $derived(
		reference && loaded ? referenceFilter(reference, loaded, index) : undefined
	);
</script>

{#if reference && filter}
	<div class="relative -m-2 p-2">
		<span class="block truncate"><CellValue {value} /></span>
		<RowsTableOutgoing {reference} {filter} />
	</div>
{:else}
	<CellValue {value} />
{/if}
