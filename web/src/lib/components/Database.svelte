<script lang="ts">
	import { createConnection } from '#lib/connection.svelte.ts';
	import { RelayError } from '#lib/protocol/client.ts';
	import TableList from './TableList.svelte';
	import { Alert, AlertTitle, AlertDescription } from '#lib/components/ui/alert/index.ts';
	import { Button } from '#lib/components/ui/button/index.ts';

	type Props = { connectorId: string; connectorKey: Uint8Array; onforget: () => void };

	let { connectorId, connectorKey, onforget }: Props = $props();

	const connection = $derived(createConnection(connectorId, connectorKey));
	$effect(() => connection.start());

	const status = $derived(connection.status);
	const overview = $derived(connection.overview);
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
			{:else if reason === 'undecryptable'}
				<AlertDescription>
					<Button variant="link" class="p-0 font-medium" onclick={onforget}>
						Enter a different key
					</Button>
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
</div>
