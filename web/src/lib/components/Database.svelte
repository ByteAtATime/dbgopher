<script lang="ts">
	import { page } from '$app/state';
	import { createConnection } from '#lib/connection.svelte.ts';
	import { createPalette } from '#lib/palette.svelte.ts';
	import { createHistory } from '#lib/search/history.ts';
	import { tableLabel } from '#lib/search/preview.ts';
	import type { Hit } from '#lib/search/rank.ts';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { toast } from 'svelte-sonner';
	import CommandPalette from './CommandPalette.svelte';
	import * as Kbd from '#lib/components/ui/kbd/index.ts';
	import { Toaster } from '#lib/components/ui/sonner/index.ts';
	import type { Sort } from '#lib/protocol/bindings/Sort.ts';
	import { RelayError } from '#lib/protocol/client.ts';
	import { incomingReferences } from '#lib/references.ts';
	import { formatRoute, parseRoute } from '#lib/route.ts';
	import XIcon from '@lucide/svelte/icons/x';
	import Pagination from './Pagination.svelte';
	import RowsTable from './RowsTable.svelte';
	import TableList from './TableList.svelte';
	import { Alert, AlertTitle, AlertDescription } from '#lib/components/ui/alert/index.ts';

	type Props = {
		userId: string;
		connectorId: string;
		connectorKey: Uint8Array;
		prekey?: Uint8Array;
	};

	const PAGE_SIZE = 50;
	const APPLE = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');

	let { userId, connectorId, connectorKey, prekey }: Props = $props();

	const connection = $derived(createConnection(connectorId, connectorKey, prekey));
	$effect(() => connection.start());

	const palette = $derived(
		createPalette({
			overview: () =>
				connection.overview.type === 'loaded' ? connection.overview.overview : undefined,
			search: (options) => connection.search(options),
			reloadOverview: () => connection.reloadOverview(),
			history: createHistory(`dbgopher:palette-history:${userId}:${connectorId}`)
		})
	);
	let paletteOpen = $state(false);

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
	const count = $derived(rows.type === 'loaded' ? rows.rows.rows.length : undefined);
	const filtered = $derived((target?.filter.length ?? 0) > 0);
	const filteredTotal = $derived(count !== undefined && count < PAGE_SIZE ? offset + count : null);
	const reason = $derived(
		status.type === 'unavailable' && status.error instanceof RelayError
			? status.error.reason
			: undefined
	);
	const searchable = $derived(
		status.type === 'online' &&
			status.hello.capabilities.includes('search') &&
			overview.type === 'loaded'
	);

	const openHit = (hit: Hit, newTab: boolean) => {
		palette.opened(hit);
		const route = `#${formatRoute({ type: 'browse', schema: hit.table.schema, table: hit.table.name, filter: hit.filter })}`;
		if (newTab) {
			window.open(`${page.url.pathname}${page.url.search}${route}`, '_blank', 'noopener');
			return;
		}
		const sameColumns =
			hit.columns.length === hit.table.columns.length &&
			hit.columns.every((name, index) => hit.table.columns[index]?.name === name);
		if (hit.identity !== undefined && sameColumns) {
			connection.seed(
				{
					schema: hit.table.schema,
					table: hit.table.name,
					filter: hit.filter,
					limit: PAGE_SIZE,
					offset: 0,
					sort: undefined
				},
				{ type: 'browse', columns: hit.table.columns, rows: [hit.cells] }
			);
		}
		paletteOpen = false;
		window.location.hash = route;
	};

	const jump = (hit: Hit) => {
		openHit(hit, false);
		const tables = overview.type === 'loaded' ? overview.overview.tables : [];
		toast(`Jumped to ${tableLabel(hit.table, tables)} #${hit.identity ?? ''}`, {
			action: { label: 'Show all results', onClick: () => (paletteOpen = true) }
		});
	};

	const onkeydown = (event: KeyboardEvent) => {
		if (!searchable || event.key.toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey)) return;
		event.preventDefault();
		paletteOpen = !paletteOpen;
	};
</script>

<svelte:window {onkeydown} />

<Toaster position="bottom-center" />

{#if searchable && overview.type === 'loaded'}
	<CommandPalette
		{palette}
		tables={overview.overview.tables}
		bind:open={paletteOpen}
		onselect={openHit}
		onjump={jump}
	/>
{/if}

<div class="flex h-dvh">
	<aside class="flex w-64 shrink-0 flex-col bg-sidebar">
		<div class="flex items-center justify-between gap-2 pt-4 pr-2 pb-2 pl-4">
			<h2 class="text-sm font-semibold">
				Tables
				{#if overview.type === 'loaded'}
					<span class="font-normal text-muted-foreground">({overview.overview.tables.length})</span>
				{/if}
			</h2>
			{#if searchable}
				<button
					type="button"
					class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					onclick={() => (paletteOpen = true)}
				>
					<SearchIcon class="size-3.5" />
					<Kbd.Group>
						<Kbd.Root>{APPLE ? '⌘' : 'Ctrl'}</Kbd.Root>
						<Kbd.Root>K</Kbd.Root>
					</Kbd.Group>
				</button>
			{/if}
		</div>
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
					/>
				</div>
			{/if}
		{/if}
	</main>
</div>
