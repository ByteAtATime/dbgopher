<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getVault, type VaultStore } from '#lib/vault.svelte.ts';
	import SetPasswordForm from './SetPasswordForm.svelte';
	import UnlockForm from './UnlockForm.svelte';
	import { Alert, AlertTitle } from '#lib/components/ui/alert/index.ts';

	type Props = { userId: string; children: Snippet<[VaultStore]> };

	let { userId, children }: Props = $props();

	const vault = $derived(getVault(userId));
	$effect(() => {
		vault.ensureLoaded();
	});
</script>

{#if vault.state.type === 'unlocked'}
	{@render children(vault)}
{:else if vault.state.type === 'missing'}
	<SetPasswordForm onsetup={vault.setup} />
{:else if vault.state.type === 'locked'}
	<UnlockForm onunlock={vault.unlock} />
{:else if vault.state.type === 'failed'}
	<Alert variant="destructive">
		<AlertTitle>{vault.state.error.message}</AlertTitle>
	</Alert>
{/if}
