<script lang="ts">
	import { WrongPasswordError } from '#lib/vault/crypto.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';

	type Props = { onunlock: (password: string) => Promise<void> };

	let { onunlock }: Props = $props();

	let password = $state('');
	let problem = $state<string>();
	let busy = $state(false);

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		busy = true;
		try {
			await onunlock(password);
		} catch (error) {
			problem =
				error instanceof WrongPasswordError
					? 'Wrong password.'
					: error instanceof Error
						? error.message
						: String(error);
		} finally {
			busy = false;
		}
	};
</script>

<form onsubmit={submit} class="mx-auto max-w-2xl space-y-4">
	<h1 class="text-lg font-semibold">Unlock</h1>

	<div class="space-y-1">
		<Label for="unlock-password">Unlock password</Label>
		<Input
			id="unlock-password"
			type="password"
			bind:value={password}
			oninput={() => (problem = undefined)}
			aria-invalid={problem !== undefined}
			autocomplete="current-password"
			required
		/>
	</div>
	{#if problem}
		<p class="text-sm text-red-600">{problem}</p>
	{/if}
	<Button type="submit" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</Button>
</form>
