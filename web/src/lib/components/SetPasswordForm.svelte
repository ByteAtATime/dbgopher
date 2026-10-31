<script lang="ts">
	import { onMount } from 'svelte';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import { cn } from '#lib/utils.ts';
	import {
		loadPasswordScorer,
		MAX_PASSWORD_SCORE,
		MIN_PASSWORD_SCORE
	} from '#lib/vault/strength.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';

	type Props = { onsetup: (password: string) => Promise<void> };

	let { onsetup }: Props = $props();

	let password = $state('');
	let visible = $state(false);
	let failure = $state<string>();
	let busy = $state(false);
	let scorer = $state<(password: string) => number>();

	const score = $derived(scorer && password ? scorer(password) : undefined);
	const weak = $derived(score !== undefined && score < MIN_PASSWORD_SCORE);

	onMount(() => {
		loadPasswordScorer().then((loaded) => (scorer = loaded));
	});

	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		if (score === undefined || weak) return;
		busy = true;
		try {
			await onsetup(password);
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	};
</script>

<form onsubmit={submit} class="mx-auto max-w-2xl space-y-4">
	<h1 class="text-lg font-semibold">Set an unlock password</h1>

	<div class="space-y-2">
		<Label for="unlock-password">Unlock password</Label>
		<div class="relative">
			<Input
				id="unlock-password"
				type={visible ? 'text' : 'password'}
				bind:value={password}
				oninput={() => (failure = undefined)}
				aria-invalid={weak || failure !== undefined}
				aria-describedby="password-problem"
				autocomplete="new-password"
				spellcheck="false"
				required
				class="pr-9"
			/>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				onclick={() => (visible = !visible)}
				aria-label={visible ? 'Hide password' : 'Show password'}
				class="absolute inset-y-0 right-0 h-full text-muted-foreground hover:bg-transparent"
			>
				{#if visible}<EyeOff />{:else}<Eye />{/if}
			</Button>
		</div>
		<div class="flex gap-1" aria-hidden="true">
			{#each { length: MAX_PASSWORD_SCORE }, index (index)}
				<div
					class={cn(
						'h-1 flex-1 rounded-full bg-muted transition-colors',
						score !== undefined &&
							index < Math.max(score, 1) &&
							(weak ? 'bg-destructive' : 'bg-emerald-600')
					)}
				></div>
			{/each}
		</div>
		<p id="password-problem" class="min-h-5 text-sm text-red-600" aria-live="polite">
			{#if failure}{failure}{:else if weak}Password is too weak.{/if}
		</p>
	</div>
	<Button type="submit" disabled={busy || score === undefined || weak}>
		{busy ? 'Unlocking…' : 'Continue'}
	</Button>
</form>
