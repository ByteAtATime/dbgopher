<script lang="ts">
	import type { ClassValue } from 'svelte/elements';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { formatLocalTimestamp, formatRelativeTime, formatUtcTimestamp } from '#lib/format.ts';
	import type { Instant } from '#lib/timestamp.ts';

	let { instant, class: className }: { instant: Instant; class?: ClassValue } = $props();
</script>

<Tooltip.Root disableHoverableContent>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<time {...props} class={['tabular-nums', className]} datetime={instant.iso}
				>{formatUtcTimestamp(instant.date)}</time
			>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content
		class="pointer-events-none max-w-none flex-col items-start gap-0 px-3 py-2 tabular-nums"
	>
		<span class="font-medium">{formatRelativeTime(instant.date)}</span>
		<span class="mt-1.5 w-full border-t border-background/15 pt-1.5 font-mono text-[11px]"
			>{instant.iso}</span
		>
		<span class="mt-0.5 opacity-70">{formatLocalTimestamp(instant.date)}</span>
	</Tooltip.Content>
</Tooltip.Root>
