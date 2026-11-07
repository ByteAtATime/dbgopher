<script lang="ts">
	import { page } from '$app/state';
	import { createConnection } from '#lib/connection.svelte.ts';
	import type { Sort } from '#lib/protocol/bindings/Sort.ts';
	import { RelayError } from '#lib/protocol/client.ts';
	import { incomingReferences, outgoingReferences } from '#lib/references.ts';
	import { formatRoute, parseRoute } from '#lib/route.ts';
	import XIcon from '@lucide/svelte/icons/x';
	import CommandPalette from './CommandPalette.svelte';
	import Pagination from './Pagination.svelte';
	import RowsTable from './RowsTable.svelte';
	import TableList from './TableList.svelte';
	import { Alert, AlertTitle, AlertDescription } from '#lib/components/ui/alert/index.ts';

	type Props = { connectorId: string; connectorKey: Uint8Array; prekey?: Uint8Array };

	const PAGE_SIZE = 50;

	let { connectorId, connectorKey, prekey }: Props = $props();

	const connection = $derived(createConnection(connectorId, connectorKey, prekey));
	$effect(() => connection.start());

	const status = $derived(connection.status);
	const overview = $derived(connection.overview);
	const rows = $derived(connection.rows);
	const route = $derived(parseRoute(page.url.hash.slice(1)));
	const table = $derived(
		route.type === 'browse'
			? { schema: route.schema, table: route.table, filter: route.filter }
			: undefined
	);
	let sort = $derived.by<Sort | undefined>(() => {
		void table;
		return undefined;
	});
	let offset = $derived.by(() => {
		void table;
		void sort;
		return 0;
	});
	const target = $derived(table && { ...table, limit: PAGE_SIZE, offset, sort });
	$effect(() => connection.select(target));
	const info = $derived(
		overview.type === 'loaded' && target
			? overview.overview.tables.find(
					(table) => table.schema === target.schema && table.name === target.table
				)
			: undefined
	);
	const columns = $derived(info?.columns ?? []);
	const references = $derived(
		overview.type === 'loaded' && target
			? incomingReferences(overview.overview.tables, target.schema, target.table)
			: []
	);
	const outgoing = $derived(
		overview.type === 'loaded' && target
			? outgoingReferences(overview.overview.tables, target.schema, target.table)
			: []
	);
	const count = $derived(rows.type === 'loaded' ? rows.rows.rows.length : undefined);
	const filtered = $derived((target?.filter.length ?? 0) > 0);
	const filteredTotal = $derived(count !== undefined && count < PAGE_SIZE ? offset + count : null);
	const reason = $derived(
		status.type === 'unavailable' && status.error instanceof RelayError
			? status.error.reason
			: undefined
	);
</script>

<div class="flex h-dvh">
	<aside class="flex w-64 shrink-0 flex-col bg-sidebar">
		<h2 class="px-4 pt-4 pb-2 text-sm font-semibold">
			Tables
			{#if overview.type === 'loaded'}
				<span class="font-normal text-muted-foreground">({overview.overview.tables.length})</span>
			{/if}
		</h2>
		<nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
			{#if overview.type === 'failed'}
				<Alert variant="destructive">
					<AlertTitle>Could not load tables</AlertTitle>
					<AlertDescription>
						<pre class="font-mono text-xs whitespace-pre-wrap">{overview.error.message}</pre>
					</AlertDescription>
				</Alert>
			{:else}
				<TableList
					tables={overview.type === 'loaded' ? overview.overview.tables : undefined}
					selected={table}
				/>
			{/if}
		</nav>
	</aside>

	<main class="flex min-w-0 flex-1 flex-col">
		{#if status.type === 'unavailable'}
			<div class="p-4">
				<Alert variant="destructive">
					<AlertTitle>{status.error.message}</AlertTitle>
					{#if reason === 'offline'}
						<AlertDescription>
							Check that the connector is running and can reach the relay.
						</AlertDescription>
					{/if}
				</Alert>
			</div>
		{/if}

		{#if target}
			<div class="flex items-center justify-between gap-4 border-l px-2 py-1">
				<div class="flex min-w-0 items-center gap-2">
					<h2 class="min-w-0 shrink-0 truncate font-semibold">
						<span class="text-muted-foreground">{target.schema}.</span>{target.table}
					</h2>
					{#if filtered}
						<span
							class="flex min-w-0 items-center gap-1 rounded-md border bg-muted py-0.5 pr-0.5 pl-2 font-mono text-xs"
						>
							<span class="truncate">
								<span class="text-muted-foreground">where</span>
								{#each target.filter as { column, value }, index (index)}
									{#if index > 0}<span class="text-muted-foreground">&#32;and&#32;</span>{/if}
									{column} = <span title={value}>{value}</span>
								{/each}
							</span>
							<a
								class="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
								href={`#${formatRoute({ type: 'browse', schema: target.schema, table: target.table, filter: [] })}`}
							>
								<XIcon class="size-3.5" />
							</a>
						</span>
					{/if}
				</div>
				<Pagination
					{offset}
					limit={PAGE_SIZE}
					{count}
					total={filtered ? filteredTotal : (info?.rowCount ?? null)}
					totalExact={filtered || (info?.rowCountExact ?? false)}
					onchange={(next) => (offset = next)}
				/>
			</div>
			{#if rows.type === 'failed'}
				<div class="p-4">
					<Alert variant="destructive">
						<AlertDescription>
							<pre class="font-mono text-xs whitespace-pre-wrap">{rows.error.message}</pre>
						</AlertDescription>
					</Alert>
				</div>
			{:else}
				<div class="min-h-0 flex-1">
					<RowsTable
						{columns}
						rows={rows.type === 'loaded'
							? rows.rows
							: rows.type === 'loading'
								? rows.previous
								: undefined}
						loading={rows.type === 'loading'}
						{sort}
						{references}
						{outgoing}
						onsort={(next) => (sort = next)}
						onprefetch={(reference, filter) =>
							connection.prefetch({
								schema: reference.schema,
								table: reference.table,
								filter,
								limit: PAGE_SIZE,
								offset: 0,
								sort: undefined
							})}
						lookup={(reference, filter) =>
							connection.lookup({
								schema: reference.schema,
								table: reference.table,
								filter,
								limit: 1,
								offset: 0,
								sort: undefined
							})}
					/>
				</div>
			{/if}
		{/if}
	</main>
</div>

<CommandPalette
	overview={overview.type === 'loaded' ? overview.overview : undefined}
	search={connection.search}
/>
