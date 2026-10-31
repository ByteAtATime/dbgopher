<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Database from '#lib/components/Database.svelte';
	import KeyForm from '#lib/components/KeyForm.svelte';
	import { forgetKey, loadKey, parseKey, saveKey } from '#lib/keys.ts';

	const connectorId = $derived(page.params.id ?? '');
	const fragmentKey = $derived(new URLSearchParams(page.url.hash.slice(1)).get('key'));
	let key = $derived(parseKey(fragmentKey ?? '') ?? loadKey(connectorId));

	onMount(() => {
		if (fragmentKey === null) return;
		if (parseKey(fragmentKey)) saveKey(connectorId, fragmentKey);
		goto(resolve('/c/[id]', { id: connectorId }), {
			state: page.state,
			shallow: true,
			replace: true
		});
	});

	const unlock = (hex: string) => {
		saveKey(connectorId, hex);
		key = parseKey(hex);
	};

	const forget = () => {
		forgetKey(connectorId);
		key = undefined;
	};
</script>

{#if key}
	<Database {connectorId} connectorKey={key} onforget={forget} />
{:else}
	<KeyForm onunlock={unlock} />
{/if}
