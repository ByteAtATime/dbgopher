<script lang="ts">
	import type { Browse } from '#lib/protocol/client.ts';
	import { formatBytes } from '#lib/format.ts';

	let { value }: { value: Browse['rows'][number][number] | undefined } = $props();
</script>

{#if value === null}
	<span class="text-muted-foreground">—</span>
{:else if value?.kind === 'binary'}
	<span class="text-muted-foreground">Binary &bull; {formatBytes(value.bytes)}</span>
{:else if value}
	<span title={value.text}>{value.text}</span>
{/if}
