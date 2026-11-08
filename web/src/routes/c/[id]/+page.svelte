<script lang="ts">
	import { page } from '$app/state';
	import Database from '#lib/components/Database.svelte';
	import PairingStatus from '#lib/components/PairingStatus.svelte';
	import VaultGate from '#lib/components/VaultGate.svelte';
	import { fromHex } from '#lib/keys.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const connectorId = $derived(page.params.id ?? '');
</script>

{#if data.user}
	<VaultGate userId={data.user.id}>
		{#snippet children(vault)}
			{@const connector = vault.connector(connectorId)}
			{@const userKey = vault.userKey()}
			{#if connector?.state === 'paired' && userKey}
				<Database
					{connectorId}
					identityKey={fromHex(connector.identityKey)}
					{userKey}
					keyConfig={data.keyConfig}
				/>
			{:else if connector?.state === 'pairing'}
				<div class="mx-auto mt-24 max-w-md px-4">
					<PairingStatus {vault} {connectorId} />
				</div>
			{:else}
				<p class="mx-auto mt-24 max-w-md px-4 text-sm">Connector not found</p>
			{/if}
		{/snippet}
	</VaultGate>
{/if}
