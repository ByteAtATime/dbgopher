<script lang="ts">
	import Database from '#lib/components/Database.svelte';
	import NewConnector from '#lib/components/NewConnector.svelte';
	import VaultGate from '#lib/components/VaultGate.svelte';
	import { fromHex } from '#lib/keys.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

{#if data.user}
	<VaultGate userId={data.user.id}>
		{#snippet children(vault)}
			{@const connector = vault.connector(data.connector.id)}
			{@const userKey = vault.userKey()}
			{#if connector?.state === 'paired' && userKey}
				<Database
					connectorId={data.connector.id}
					identityKey={fromHex(connector.identityKey)}
					{userKey}
					keyConfig={data.keyConfig}
				/>
			{:else if connector || data.connector.enrollment !== 'enrolled'}
				<main class="mx-auto max-w-2xl px-4 py-12">
					<NewConnector {vault} resume={data.connector} />
				</main>
			{:else}
				<p class="mx-auto mt-24 max-w-md px-4 text-sm">Connector not found</p>
			{/if}
		{/snippet}
	</VaultGate>
{/if}
