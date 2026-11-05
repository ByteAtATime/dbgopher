<script lang="ts">
	import { page } from '$app/state';
	import Database from '#lib/components/Database.svelte';
	import VaultGate from '#lib/components/VaultGate.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const connectorId = $derived(page.params.id ?? '');
</script>

{#if data.user}
	<VaultGate userId={data.user.id}>
		{#snippet children(vault)}
			{@const key = vault.connectorKey(connectorId)}
			{#if key}
				<Database {connectorId} connectorKey={key} prekey={data.prekey} />
			{:else}
				<p class="mx-auto mt-24 max-w-md px-4 text-sm">Connector not found</p>
			{/if}
		{/snippet}
	</VaultGate>
{/if}
