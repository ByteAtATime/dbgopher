<script lang="ts">
	import { Command as CommandPrimitive } from 'bits-ui';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { cn } from '#lib/utils.js';

	let {
		ref = $bindable(null),
		class: className,
		value = $bindable(''),
		...restProps
	}: CommandPrimitive.InputProps = $props();
</script>

<div data-slot="command-input-wrapper" class="flex items-center gap-3 px-3">
	<SearchIcon class="size-4 shrink-0 text-muted-foreground" />
	<CommandPrimitive.Input
		bind:ref
		bind:value
		data-slot="command-input"
		class={cn(
			'h-12 w-full min-w-0 bg-transparent text-base outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
			className
		)}
		{...restProps}
	/>
</div>
