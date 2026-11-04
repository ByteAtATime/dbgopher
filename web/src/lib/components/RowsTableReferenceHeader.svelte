<script lang="ts">
	import type { IHeaderCellProps } from '@svar-ui/svelte-grid';
	import CornerDownRightIcon from '@lucide/svelte/icons/corner-down-right';

	let { cell }: IHeaderCellProps = $props();
</script>

<div class="flex min-w-0 flex-1 cursor-default items-center gap-1.5">
	<CornerDownRightIcon class="size-3.5 shrink-0" />
	<span class="truncate">{cell.text}</span>
</div>
