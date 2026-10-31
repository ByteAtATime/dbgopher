<script lang="ts">
	import { page } from '$app/state';
	import { createConnection } from '#lib/connection.svelte.ts';
	import { RelayError } from '#lib/protocol/client.ts';
	import { parseRoute } from '#lib/route.ts';
	import Pagination from './Pagination.svelte';
	import RowsTable from './RowsTable.svelte';
	import TableList from './TableList.svelte';
	import { Alert, AlertTitle, AlertDescription } from '#lib/components/ui/alert/index.ts';

	type Props = { connectorId: string; connectorKey: Uint8Array };

	const PAGE_SIZE = 50;

	let { connectorId, connectorKey }: Props = $props();

	const connection = $derived(createConnection(connectorId, connectorKey));
	$effect(() => connection.start());

	const status = $derived(connection.status);
	const overview = $derived(connection.overview);
	const rows = $derived(connection.rows);
	const route = $derived(parseRoute(page.url.hash.slice(1)));
	const table = $derived(
		route.type === 'browse' ? { schema: route.schema, table: route.table } : undefined
	);
	let offset = $derived.by(() => {
		void table;
		return 0;
	});
	const target = $derived(table && { ...table, limit: PAGE_SIZE, offset });
	$effect(() => connection.select(target));
	const info = $derived(
		overview.type === 'loaded' && target
			? overview.overview.tables.find(
					(table) => table.schema === target.schema && table.name === target.table
				)
			: undefined
	);
	const columns = $derived(info?.columns.map((column) => column.name) ?? []);
	const reason = $derived(
		status.type === 'unavailable' && status.error instanceof RelayError
			? status.error.reason
			: undefined
	);
</script>

<div class="flex h-dvh">
	<aside class="flex w-64 shrink-0 flex-col border-r bg-sidebar">
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
			<div class="flex items-center justify-between gap-4 border-b px-2 py-1">
				<h2 class="min-w-0 truncate font-semibold">
					<span class="text-muted-foreground">{target.schema}.</span>{target.table}
				</h2>
				<Pagination
					{offset}
					limit={PAGE_SIZE}
					count={rows.type === 'loaded' ? rows.rows.rows.length : undefined}
					total={info?.rowCount ?? null}
					totalExact={info?.rowCountExact ?? false}
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
				<div
					class="min-h-0 flex-1 overflow-auto **:data-[slot=table-container]:overflow-visible [&_thead]:sticky [&_thead]:top-0 [&_thead]:bg-background"
				>
					<RowsTable {columns} rows={rows.type === 'loaded' ? rows.rows : undefined} />
				</div>
			{/if}
		{/if}
	</main>
</div>
