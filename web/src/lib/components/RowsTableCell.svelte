<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { Browse } from '#lib/protocol/client.ts';

	export const [getRows, setRows] = createContext<() => Browse | undefined>();
</script>

<script lang="ts">
	import type { ICellProps } from '@svar-ui/svelte-grid';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import { formatBytes } from '#lib/format.ts';

	let { row, column }: ICellProps = $props();

	const rows = getRows();

	const loaded = $derived(rows());
	const value = $derived(loaded?.rows[Number(row.id)]?.[Number(column.id)]);
</script>

{#if !loaded}
	<Skeleton class="inline-block h-5 w-20 align-middle" />
{:else if value === null || value === undefined}
	<span class="text-muted-foreground">—</span>
{:else if value.kind === 'binary'}
	<span class="text-muted-foreground">Binary &bull; {formatBytes(value.bytes)}</span>
{:else}
	<span title={value.text}>{value.text}</span>
{/if}
