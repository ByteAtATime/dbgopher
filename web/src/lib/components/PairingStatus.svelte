<script lang="ts">
	import { createPairing } from '#lib/pairing.svelte.ts';
	import type { VaultStore } from '#lib/vault.svelte.ts';

	type Props = { vault: VaultStore; connectorId: string };

	let { vault, connectorId }: Props = $props();

	const pairing = $derived(createPairing(vault, connectorId));
	$effect(() => pairing.start());
</script>

{#if pairing.status === 'waiting'}
	<p class="text-sm text-muted-foreground">Waiting for the connector to pair.</p>
{:else if pairing.status === 'failed'}
	<p class="text-sm text-red-600">
		Pairing failed. The connector's proof does not match the pairing code.
	</p>
{/if}
