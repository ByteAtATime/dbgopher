<script lang="ts" module>
	import { createContext } from 'svelte';
	import type { BrowseResult } from '#lib/browse-cache.ts';
	import type { Filter } from '#lib/protocol/bindings/Filter.ts';
	import type { Reference } from '#lib/references.ts';

	export type OutgoingLinks = {
		references: () => Reference[];
		lookup: (reference: Reference, filter: Filter[]) => Promise<BrowseResult>;
		onprefetch: (reference: Reference, filter: Filter[]) => void;
	};

	export const [getOutgoingLinks, setOutgoingLinks] = createContext<OutgoingLinks>();
</script>

<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Button } from '#lib/components/ui/button/index.ts';
	import * as Popover from '#lib/components/ui/popover/index.ts';
	import { formatRoute } from '#lib/route.ts';
	import CellValue from './CellValue.svelte';

	let { reference, filter }: { reference: Reference; filter: Filter[] } = $props();

	const links = getOutgoingLinks();

	const route = $derived(
		formatRoute({ type: 'browse', schema: reference.schema, table: reference.table, filter })
	);
	let open = $derived.by(() => {
		void route;
		return false;
	});

	const result = $derived(open ? links.lookup(reference, filter) : undefined);
</script>

{#key route}
	<span
		class="absolute inset-y-0 right-0 flex bg-[linear-gradient(to_right,transparent,var(--cell-background)_0.75rem)] pl-4 opacity-0 has-focus-visible:opacity-100 has-data-[state=open]:opacity-100 [.wx-cell:hover_&]:opacity-100"
	>
		<Popover.Root bind:open>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant="ghost"
						size="icon-xs"
						class="h-full w-8 rounded-none text-muted-foreground"
						onpointerenter={() => void links.lookup(reference, filter)}
					>
						<ArrowUpRightIcon />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content align="start" class="w-96 gap-2 p-3 text-xs">
				<Button
					variant="secondary"
					class="h-7 w-full rounded-sm hover:bg-primary hover:text-primary-foreground"
					href={`#${route}`}
					onpointerenter={() => links.onprefetch(reference, filter)}
				>
					<ArrowRightIcon class="size-3.5" />
				</Button>
				<Popover.Title class="truncate text-sm">{reference.label}</Popover.Title>
				{#await result}
					<LoaderCircleIcon class="size-4 animate-spin text-muted-foreground" />
				{:then outcome}
					{#if outcome?.type === 'failed'}
						<pre class="font-mono whitespace-pre-wrap text-destructive">{outcome.error
								.message}</pre>
					{:else if outcome?.rows.rows[0]}
						{@const row = outcome.rows.rows[0]}
						<dl
							class="grid max-h-80 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 overflow-y-auto"
						>
							{#each outcome.rows.columns as column, index (column.name)}
								<dt class="text-muted-foreground">{column.name}</dt>
								<dd class="truncate font-mono"><CellValue value={row[index]} {column} /></dd>
							{/each}
						</dl>
					{:else if outcome}
						<span class="text-muted-foreground">—</span>
					{/if}
				{/await}
			</Popover.Content>
		</Popover.Root>
	</span>
{/key}
