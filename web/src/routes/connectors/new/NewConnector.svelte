<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import confetti from 'canvas-confetti';
	import { fly, scale, slide } from 'svelte/transition';
	import { backOut } from 'svelte/easing';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Plug from '@lucide/svelte/icons/plug';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { Label } from '#lib/components/ui/label/index.ts';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { environments, type Environment } from '#lib/environments.ts';
	import { createPairing } from '#lib/pairing.svelte.ts';
	import type { VaultStore } from '#lib/vault.svelte.ts';
	import type { SubmitFunction } from './$types';

	type Created = { id: string; name: string; pairingCode: string; userKey: string };

	let { vault }: { vault: VaultStore } = $props();

	let name = $state('');
	let environment = $state<Environment>('production');
	let created = $state<Created>();
	let submitting = $state(false);
	let failure = $state<string>();
	let copied = $state(false);
	let revealed = $state(false);
	let celebrate = $state(false);

	const relayUrl = $derived(
		`${page.url.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.url.host}/connector`
	);

	type CommandLine = { key: string; value: string; secret?: boolean };

	const commandLines = (connector: Created): CommandLine[] => [
		{ key: 'RELAY_URL', value: relayUrl },
		{ key: 'CONNECTOR_ID', value: connector.id },
		{ key: 'PAIRING_CODE', value: connector.pairingCode, secret: true },
		{ key: 'USER_KEY', value: connector.userKey, secret: true },
		{ key: 'CONNECTOR_STATE_DIR', value: `$HOME/.local/state/dbgopher/${connector.id}` },
		{ key: 'DATABASE_URL', value: '<database url>' }
	];

	const ACTIVE_CARD =
		'border-primary/25 bg-[radial-gradient(90%_120%_at_0%_0%,var(--primary-soft),transparent_55%)]';

	const RUN = 'cargo run --manifest-path connector/Cargo.toml';
	const BREAK = ' \\\n';
	const MASK = '•'.repeat(24);

	const command = (connector: Created) =>
		[...commandLines(connector).map(({ key, value }) => `${key}=${value}`), RUN].join(BREAK);

	const pairing = $derived(created && createPairing(vault, created.id));
	$effect(() => pairing?.start());

	$effect(() => {
		if (pairing?.status !== 'paired' || !celebrate) return;
		celebrate = false;
		const colors = ['#c5f26b', '#7db8ff', '#f4b544', '#ff8ab3', '#eceef2'];
		const burst = (x: number, angle: number) =>
			confetti({
				particleCount: 90,
				spread: 70,
				startVelocity: 55,
				angle,
				origin: { x, y: 0.75 },
				colors,
				disableForReducedMotion: true
			});
		void burst(0.15, 60);
		void burst(0.85, 120);
		setTimeout(
			() =>
				void confetti({
					particleCount: 140,
					spread: 120,
					origin: { y: 0.45 },
					colors,
					disableForReducedMotion: true
				}),
			250
		);
	});

	const create: SubmitFunction = () => {
		submitting = true;
		failure = undefined;
		const first = vault.connectors().every((entry) => entry.state !== 'paired');
		return async ({ result }) => {
			try {
				if (result.type === 'success' && result.data) {
					const { id, enrollmentToken } = result.data;
					const { pairingSecret, userKey } = await vault.startPairing(id);
					created = { id, name, pairingCode: `${enrollmentToken}.${pairingSecret}`, userKey };
					celebrate = first;
				}
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			} finally {
				submitting = false;
			}
		};
	};

	const glow = (node: HTMLElement) => {
		const move = (event: PointerEvent) => {
			const rect = node.getBoundingClientRect();
			node.style.setProperty('--x', `${event.clientX - rect.left}px`);
			node.style.setProperty('--y', `${event.clientY - rect.top}px`);
		};
		node.addEventListener('pointermove', move);
		return () => node.removeEventListener('pointermove', move);
	};

	const copy = async (text: string) => {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 1600);
	};
</script>

{#snippet step(number: number, done: boolean)}
	<span
		class="grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold transition-colors {done
			? 'bg-primary text-primary-foreground'
			: 'bg-primary-soft text-brand ring-1 ring-primary/30'}"
	>
		{#if done}
			<span in:scale={{ duration: 300, easing: backOut }}
				><Check class="size-4" strokeWidth={3} /></span
			>
		{:else}
			{number}
		{/if}
	</span>
{/snippet}

<div class="space-y-5">
	<header class="flex items-center gap-3 pb-3">
		<span
			class="grid size-11 -rotate-6 place-items-center rounded-xl bg-primary-soft text-brand ring-1 ring-primary/25"
		>
			<Plug class="size-5" />
		</span>
		<h1 class="text-2xl font-semibold tracking-tight text-card-foreground">New connector</h1>
	</header>

	<form
		method="POST"
		use:enhance={create}
		class="rounded-xl border bg-card p-6 transition-colors {created ? '' : ACTIVE_CARD}"
	>
		<div class="flex items-center gap-3">
			{@render step(1, created !== undefined)}
			<h2 class="font-semibold text-card-foreground">Name it</h2>
			{#if created}
				<div in:fly={{ x: 8, duration: 300 }} class="ml-auto flex min-w-0 items-center gap-2">
					<span class="truncate text-sm font-medium text-card-foreground">{created.name}</span>
					<span
						class="flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium {environments[
							environment
						].badge}"
					>
						{environments[environment].label}
					</span>
				</div>
			{/if}
		</div>
		{#if !created}
			<div out:slide={{ duration: 250 }} class="space-y-5 pt-5">
				<fieldset disabled={created !== undefined || submitting} class="grid gap-5 sm:grid-cols-2">
					<div class="space-y-2">
						<Label for="connector-name">Name</Label>
						<Input
							id="connector-name"
							name="name"
							autocomplete="off"
							data-protonpass-ignore
							data-1p-ignore
							data-lpignore="true"
							data-bwignore
							class="focus-visible:ring-0"
							required
							bind:value={name}
						/>
					</div>
					<div class="space-y-2" role="radiogroup" aria-labelledby="environment-label">
						<span id="environment-label" class="flex text-sm leading-none font-medium select-none"
							>Environment</span
						>
						<div class="flex h-9 gap-0.5 rounded-md border border-input p-0.5">
							{#each Object.entries(environments) as [value, option] (value)}
								<label
									class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-[5px] px-2 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground has-checked:bg-secondary has-checked:text-foreground has-checked:shadow-lift has-focus-visible:ring-2 has-focus-visible:ring-ring/50"
								>
									<input
										type="radio"
										name="environment"
										{value}
										bind:group={environment}
										class="sr-only"
									/>
									<span class="size-1.5 rounded-full {option.dot}"></span>
									{option.label}
								</label>
							{/each}
						</div>
					</div>
				</fieldset>
				<div class="flex items-center justify-end gap-3">
					{#if failure}
						<p class="mr-auto text-sm text-destructive">{failure}</p>
					{/if}
					<Button type="submit" disabled={submitting}>
						Continue <ArrowRight />
					</Button>
				</div>
			</div>
		{/if}
	</form>

	{#if created && pairing}
		<section
			in:fly={{ y: 16, duration: 350 }}
			class="space-y-4 rounded-xl border bg-card p-6 transition-colors {pairing.status === 'paired'
				? ''
				: ACTIVE_CARD}"
		>
			<div class="flex items-center gap-3">
				{@render step(2, pairing.status === 'paired')}
				<h2 class="font-semibold text-card-foreground">Run the connector on the database host</h2>
				<Button
					variant="ghost"
					size="icon-sm"
					class="ml-auto text-muted-foreground"
					aria-label="Reveal"
					aria-pressed={revealed}
					onclick={() => (revealed = !revealed)}
				>
					{#if revealed}<EyeOff />{:else}<Eye />{/if}
				</Button>
				<Button
					variant={copied ? 'default' : 'secondary'}
					size="sm"
					onclick={() => created && copy(command(created))}
				>
					{#if copied}<Check />{:else}<Copy />{/if}
					Copy
				</Button>
			</div>
			<div class="rounded-lg border bg-background">
				<pre class="overflow-x-auto p-4 font-mono text-[13px] leading-6 whitespace-pre"><code
						>{#each commandLines(created) as { key, value, secret } (key)}<span class="text-info"
								>{key}</span
							><span class="text-faint-foreground">=</span>{#if secret && !revealed}<span
									class="text-card-foreground">{value.slice(0, 6)}</span
								><span class="tracking-tight text-faint-foreground">{MASK}</span>{:else}<span
									class={value.startsWith('<') ? 'text-warn' : 'text-card-foreground'}>{value}</span
								>{/if}<span class="text-faint-foreground">{BREAK}</span>{/each}<span
							class="text-brand">{RUN}</span
						></code
					></pre>
			</div>
		</section>

		<section
			in:fly={{ y: 16, duration: 350, delay: 120 }}
			{@attach glow}
			class="group/finish relative overflow-hidden rounded-xl p-px transition-[background] duration-500 {pairing.status ===
			'paired'
				? 'bg-[linear-gradient(135deg,var(--primary),var(--info)_55%,var(--spark))]'
				: 'bg-[linear-gradient(135deg,color-mix(in_oklch,var(--primary),transparent_70%),var(--border)_45%,color-mix(in_oklch,var(--info),transparent_75%))]'}"
		>
			<div
				aria-hidden="true"
				class="pointer-events-none absolute inset-0 bg-[radial-gradient(120px_circle_at_var(--x,50%)_var(--y,50%),var(--primary),transparent_70%)] opacity-0 transition-opacity duration-300 group-hover/finish:opacity-100"
			></div>
			<div class="relative overflow-hidden rounded-[11px] bg-background px-6 py-5">
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 bg-[radial-gradient(color-mix(in_oklch,var(--foreground),transparent_86%)_1px,transparent_1px)] mask-[linear-gradient(90deg,transparent,black_40%,black)] bg-size-[12px_12px]"
				></div>
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 transition-opacity duration-700 {pairing.status ===
					'paired'
						? 'opacity-100'
						: 'opacity-40'} bg-[radial-gradient(45%_160%_at_100%_100%,color-mix(in_oklch,var(--info),transparent_78%),transparent),radial-gradient(35%_140%_at_70%_0%,color-mix(in_oklch,var(--spark),transparent_84%),transparent),radial-gradient(40%_160%_at_0%_50%,color-mix(in_oklch,var(--primary),transparent_86%),transparent)]"
				></div>
				<div
					aria-hidden="true"
					class="pointer-events-none absolute inset-0 bg-[radial-gradient(190px_circle_at_var(--x,50%)_var(--y,50%),color-mix(in_oklch,var(--primary),transparent_88%),transparent_70%)] opacity-0 transition-opacity duration-300 group-hover/finish:opacity-100"
				></div>
				{#if pairing.status === 'paired'}
					<div
						in:scale={{ start: 0.9, duration: 400, easing: backOut }}
						class="relative flex items-center gap-3"
					>
						<span
							class="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_0_16px_color-mix(in_oklch,var(--primary),transparent_50%)]"
						>
							<Check class="size-4" strokeWidth={3} />
						</span>
						<div class="flex min-w-0 flex-1 items-center gap-2">
							<span class="truncate font-semibold text-card-foreground">{created.name}</span>
							<span
								class="rounded-md px-2 py-0.5 text-xs font-medium {environments[environment].badge}"
								>{environments[environment].label}</span
							>
						</div>
						<Button href={resolve('/c/[id]', { id: created.id })}>
							Go to connector <ArrowRight />
						</Button>
					</div>
				{:else if pairing.status === 'failed'}
					<p class="relative text-sm text-destructive">
						Pairing failed. The connector's proof does not match the pairing code.
					</p>
				{:else}
					<div class="relative flex items-center gap-3">
						<Tooltip.Provider>
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<span {...props} class="grid size-7 shrink-0 place-items-center">
											<span class="relative flex size-3">
												<span class="absolute inset-0 animate-ping rounded-full bg-primary/60"
												></span>
												<span class="relative size-3 rounded-full bg-primary"></span>
											</span>
										</span>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content>
									I swear I made this myself, LLMs have ruined this cool dot thingy smh
								</Tooltip.Content>
							</Tooltip.Root>
						</Tooltip.Provider>
						<p class="font-semibold text-card-foreground">
							Waiting for {created.name} to dial in<span class="inline-flex w-4"
								><span class="animate-pulse">…</span></span
							>
						</p>
					</div>
				{/if}
			</div>
		</section>
	{/if}
</div>
