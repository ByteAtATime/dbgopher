<script lang="ts">
	import type { ClassValue } from 'svelte/elements';
	import type { Browse } from '#lib/protocol/client.ts';
	import { formatBytes } from '#lib/format.ts';
	import { isTimestampColumn, parseTimestamp } from '#lib/timestamp.ts';
	import Timestamp from './Timestamp.svelte';

	let {
		value,
		column,
		class: className
	}: {
		value: Browse['rows'][number][number] | undefined;
		column: Browse['columns'][number] | undefined;
		class?: ClassValue;
	} = $props();

	const instant = $derived(
		value?.kind === 'text' && column && isTimestampColumn(column)
			? parseTimestamp(value.text)
			: undefined
	);
</script>

{#if value === null}
	<span class={['text-muted-foreground', className]}>—</span>
{:else if value?.kind === 'binary'}
	<span class={['text-muted-foreground', className]}>Binary &bull; {formatBytes(value.bytes)}</span>
{:else if instant}
	<Timestamp {instant} class={className} />
{:else if value}
	<span class={className} title={value.text}>{value.text}</span>
{/if}
