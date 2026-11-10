<script lang="ts">
	import NewConnector from '#lib/components/NewConnector.svelte';
	import VaultGate from '#lib/components/VaultGate.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

{#if data.user}
	<main class="mx-auto max-w-2xl px-4 py-12">
		<VaultGate userId={data.user.id}>
			{#snippet children(vault)}
				<NewConnector {vault} />
			{/snippet}
		</VaultGate>
	</main>
{/if}
