<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import { formatRowCount } from '#lib/format.ts';

	type Props = {
		offset: number;
		limit: number;
		count?: number;
		total: number | null;
		totalExact: boolean;
		onchange: (offset: number) => void;
	};

	let { offset, limit, count, total, totalExact, onchange }: Props = $props();

	const hasNext = $derived(
		count === limit && !(totalExact && total !== null && offset + count >= total)
	);
</script>

<div class="flex items-center justify-end gap-2 text-sm text-muted-foreground tabular-nums">
	{#if count === undefined}
		<Skeleton class="h-5 w-28" />
	{:else}
		<span>
			{formatRowCount(count === 0 ? offset : offset + 1, true)} - {formatRowCount(
				offset + count,
				true
			)} of {formatRowCount(total, totalExact)}
		</span>
	{/if}
	<Button
		variant="outline"
		size="icon-sm"
		disabled={count === undefined || offset === 0}
		onclick={() => onchange(Math.max(offset - limit, 0))}
	>
		<ChevronLeft />
	</Button>
	<Button
		variant="outline"
		size="icon-sm"
		disabled={!hasNext}
		onclick={() => onchange(offset + limit)}
	>
		<ChevronRight />
	</Button>
</div>
