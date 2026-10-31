<script lang="ts">
	import { parseKey } from '#lib/keys.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';

	type Props = { onunlock: (hex: string) => void };

	let { onunlock }: Props = $props();

	let value = $state('');
	let invalid = $state(false);

	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		if (parseKey(value)) onunlock(value);
		else invalid = true;
	};
</script>

<form onsubmit={submit} class="mx-auto mt-24 max-w-md space-y-4 px-4">
	<h1 class="text-lg font-semibold">Unlock</h1>

	<div class="space-y-1">
		<Label for="connector-key">Connector key</Label>
		<Input
			id="connector-key"
			bind:value
			oninput={() => (invalid = false)}
			aria-invalid={invalid}
			autocomplete="off"
			spellcheck="false"
			class="font-mono"
		/>
	</div>
	{#if invalid}
		<p class="text-sm text-red-600">The key should be 64 hex chars.</p>
	{/if}
	<Button type="submit">Unlock</Button>
</form>
