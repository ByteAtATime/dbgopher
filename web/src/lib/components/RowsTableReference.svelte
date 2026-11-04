<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { Filter } from '#lib/protocol/bindings/Filter.ts';
	import type { Reference } from '#lib/references.ts';

	export type ReferenceLinks = {
		references: () => Reference[];
		columns: () => number;
		onprefetch: (reference: Reference, filter: Filter[]) => void;
	};

	export const [getReferenceLinks, setReferenceLinks] = createContext<ReferenceLinks>();
</script>

<script lang="ts">
	import type { ICellProps } from '@svar-ui/svelte-grid';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { referenceFilter } from '#lib/references.ts';
	import { formatRoute } from '#lib/route.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { getRows } from './RowsTableCell.svelte';

	let { row, column }: ICellProps = $props();

	const rows = getRows();
	const links = getReferenceLinks();

	const reference = $derived(links.references()[Number(column.id) - links.columns() - 1]);
	const loaded = $derived(rows());
	const filter = $derived(
		reference && loaded ? referenceFilter(reference, loaded, Number(row.id) - 1) : undefined
	);
	const route = $derived(
		reference &&
			filter &&
			formatRoute({ type: 'browse', schema: reference.schema, table: reference.table, filter })
	);
</script>

{#if reference && filter && route}
	{#key route}
		<div class="-m-1">
			<Button
				variant="secondary"
				class="h-6 w-full rounded-sm hover:bg-primary hover:text-primary-foreground"
				href={`#${route}`}
				onpointerenter={() => links.onprefetch(reference, filter)}
				onfocus={() => links.onprefetch(reference, filter)}
			>
				<ArrowRightIcon class="size-3.5" />
			</Button>
		</div>
	{/key}
{/if}
