<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Timestamp from '#lib/components/Timestamp.svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { instantOf } from '#lib/timestamp.ts';
	import VaultGate from '#lib/components/VaultGate.svelte';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { Input } from '#lib/components/ui/input/index.ts';
	import { generateKey } from '#lib/keys.ts';
	import { forgetVault, type VaultStore } from '#lib/vault.svelte.ts';
	import type { PageProps, SubmitFunction } from './$types';

	type Created = { id: string; token: string; key: string };

	let { data }: PageProps = $props();

	let created = $state<Created>();
	let failure = $state<string>();

	const relayUrl = $derived(
		`${page.url.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.url.host}/connector`
	);

	const command = (connector: Created) =>
		`RELAY_URL=${relayUrl} CONNECTOR_ID=${connector.id} CONNECTOR_TOKEN=${connector.token} CONNECTOR_KEY=${connector.key} DATABASE_URL=<database url> cargo run --manifest-path connector/Cargo.toml`;

	const create =
		(vault: VaultStore): SubmitFunction =>
		() =>
		async ({ result, update }) => {
			failure = undefined;
			if (result.type === 'success' && result.data) {
				const connector = { ...result.data, key: generateKey() };
				try {
					await vault.addConnectorKey(connector.id, connector.key);
					created = connector;
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
			}
			await update();
		};
</script>

<main class="mx-auto max-w-2xl space-y-6 px-4 py-6">
	<h1 class="text-lg font-semibold">dbgopher</h1>
	{#if data.user}
		<p class="text-sm">Signed in as {data.user.email}</p>

		<section class="space-y-3">
			<h2 class="font-semibold">Connectors</h2>
			{#if data.connectors.length > 0}
				<Tooltip.Provider>
					<ul class="divide-y rounded-md border">
						{#each data.connectors as connector (connector.id)}
							<li>
								<a
									href={resolve('/c/[id]', { id: connector.id })}
									class="flex justify-between gap-4 p-3 text-sm hover:bg-muted"
								>
									<span>
										{connector.name}

										({#if connector.online}
											Online
										{:else if connector.lastSeenAt}
											Offline; last seen <Timestamp instant={instantOf(connector.lastSeenAt)} />
										{:else}
											Offline
										{/if})
									</span>
									<span class="text-muted-foreground"
										><Timestamp instant={instantOf(connector.createdAt)} /></span
									>
								</a>
							</li>
						{/each}
					</ul>
				</Tooltip.Provider>
			{/if}
			<VaultGate userId={data.user.id}>
				{#snippet children(vault)}
					{#if created}
						<pre
							class="overflow-x-auto rounded bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">{command(
								created
							)}</pre>
						<Button href={resolve('/c/[id]', { id: created.id })}>Go to connector</Button>
					{/if}
					<form
						method="POST"
						action="?/createConnector"
						use:enhance={create(vault)}
						class="flex gap-2"
					>
						<Input name="name" placeholder="Name" aria-label="Name" required />
						<Button type="submit">New connector</Button>
					</form>
					{#if failure}
						<p class="text-sm text-red-600">{failure}</p>
					{/if}
				{/snippet}
			</VaultGate>
		</section>

		<form method="POST" action="?/signOut" onsubmit={() => data.user && forgetVault(data.user.id)}>
			<Button type="submit" variant="outline">Sign out</Button>
		</form>
	{:else}
		<Button href={resolve('/sign-in')}>Sign in</Button>
	{/if}
</main>
