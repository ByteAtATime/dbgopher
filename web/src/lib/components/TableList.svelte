<script lang="ts">
	import TableIcon from '@lucide/svelte/icons/table';
	import ViewIcon from '@lucide/svelte/icons/view';
	import { formatRowCount } from '#lib/format.ts';
	import { formatRoute } from '#lib/route.ts';
	import { cn } from '#lib/utils.js';
	import type { Table } from '#lib/protocol/bindings/Table.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';

	type Props = { tables?: Table[]; selected?: { schema: string; table: string } };

	let { tables, selected }: Props = $props();

	const iconFor = (table: Table) =>
		table.kind === 'view' || table.kind === 'materializedView' ? ViewIcon : TableIcon;
	const showIcons = $derived(new Set(tables?.map(iconFor)).size > 1);
	const singleSchema = $derived(
		tables && tables.length > 0 ? new Set(tables.map((t) => t.schema)).size === 1 : false
	);
</script>

<ul class="space-y-0.5">
	{#if tables}
		{#each tables as table (`${table.schema}.${table.name}`)}
			{@const active = selected?.schema === table.schema && selected.table === table.name}
			{@const Icon = iconFor(table)}
			<li>
				<a
					class={cn(
						'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground hover:bg-accent',
						active && 'bg-accent font-medium'
					)}
					aria-current={active ? 'page' : undefined}
					href={`#${formatRoute({ type: 'browse', schema: table.schema, table: table.name })}`}
				>
					{#if showIcons}
						<Icon class="size-4 shrink-0 text-muted-foreground" />
					{/if}
					<span class="min-w-0 flex-1 truncate">
						{#if !singleSchema}<span class="text-muted-foreground">{table.schema}.</span>{/if}{table.name}
					</span>
					<span
						class="shrink-0 text-xs text-muted-foreground tabular-nums"
						title={table.rowCountExact ? undefined : 'Estimated from table statistics'}
					>
						{formatRowCount(table.rowCount, table.rowCountExact)}
					</span>
				</a>
			</li>
		{:else}
			<li class="px-2 py-1.5 text-sm text-muted-foreground">Unable to load tables</li>
		{/each}
	{:else}
		{#each { length: 8 }, index (index)}
			<li aria-hidden="true" class="flex items-center gap-2 px-2 py-1.5">
				<Skeleton class="h-5 flex-1" />
				<Skeleton class="h-5 w-8" />
			</li>
		{/each}
	{/if}
</ul>
