<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { Browse } from '#lib/protocol/client.ts';

	export const [getRows, setRows] = createContext<() => Browse | undefined>();
</script>

<script lang="ts">
	import type { ICellProps } from '@svar-ui/svelte-grid';
	import { formatBytes } from '#lib/format.ts';

	let { row, column }: ICellProps = $props();

	const rows = getRows();

	const value = $derived(rows()?.rows[Number(row.id)]?.[Number(column.id)]);
</script>

{#if value === null}
	<span class="text-muted-foreground">—</span>
{:else if value?.kind === 'binary'}
	<span class="text-muted-foreground">Binary &bull; {formatBytes(value.bytes)}</span>
{:else if value}
	<span title={value.text}>{value.text}</span>
{/if}
