<script lang="ts">
	import { createConnection } from '#lib/connection.svelte.ts';
	import { RelayError } from '#lib/protocol/client.ts';
	import RowsTable from './RowsTable.svelte';
	import TableList from './TableList.svelte';
	import { Alert, AlertTitle, AlertDescription } from '#lib/components/ui/alert/index.ts';

	type Props = { connectorId: string; connectorKey: Uint8Array };

	let { connectorId, connectorKey }: Props = $props();

	const connection = $derived(createConnection(connectorId, connectorKey));
	$effect(() => connection.start());

	const status = $derived(connection.status);
	const overview = $derived(connection.overview);
	const rows = $derived(connection.rows);
	const first = $derived(overview.type === 'loaded' ? overview.overview.tables[0] : undefined);
	const reason = $derived(
		status.type === 'unavailable' && status.error instanceof RelayError
			? status.error.reason
			: undefined
	);
</script>

<div class="mx-auto max-w-5xl space-y-6 px-4 py-6">
	{#if status.type === 'unavailable'}
		<Alert variant="destructive">
			<AlertTitle>{status.error.message}</AlertTitle>
			{#if reason === 'offline'}
				<AlertDescription>
					Check that the connector is running and can reach the relay. This page checks again every
					10 seconds.
				</AlertDescription>
			{/if}
		</Alert>
	{/if}

	<section class="space-y-3">
		<h2 class="font-semibold">
			Tables
			{#if overview.type === 'loaded'}
				<span class="font-normal text-muted-foreground">({overview.overview.tables.length})</span>
			{/if}
		</h2>
		{#if overview.type === 'failed'}
			<Alert variant="destructive">
				<AlertTitle>Could not load tables</AlertTitle>
				<AlertDescription>
					<pre class="font-mono text-xs whitespace-pre-wrap">{overview.error.message}</pre>
				</AlertDescription>
			</Alert>
		{:else}
			<TableList tables={overview.type === 'loaded' ? overview.overview.tables : undefined} />
		{/if}
	</section>

	{#if first}
		<section class="space-y-3">
			<h2 class="font-semibold wrap-anywhere">
				<span class="text-muted-foreground">{first.schema}.</span>{first.name}
			</h2>
			{#if rows.type === 'failed'}
				<Alert variant="destructive">
					<AlertDescription>
						<pre class="font-mono text-xs whitespace-pre-wrap">{rows.error.message}</pre>
					</AlertDescription>
				</Alert>
			{:else}
				<RowsTable
					columns={first.columns
						.filter((column) => column.typeName !== 'bytea')
						.map((column) => column.name)}
					rows={rows.type === 'loaded' ? rows.rows : undefined}
				/>
			{/if}
		</section>
	{/if}
</div>
