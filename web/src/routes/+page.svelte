<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { generateKey } from '#lib/keys.ts';
	import type { PageProps, SubmitFunction } from './$types';

	type Created = { id: string; token: string; key: string };

	let { data }: PageProps = $props();

	let created = $state<Created>();

	const relayUrl = $derived(
		`${page.url.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.url.host}/connector`
	);

	const command = (connector: Created) =>
		`RELAY_URL=${relayUrl} CONNECTOR_ID=${connector.id} CONNECTOR_TOKEN=${connector.token} CONNECTOR_KEY=${connector.key} DATABASE_URL=<database url> cargo run --manifest-path connector/Cargo.toml`;

	const create: SubmitFunction =
		() =>
		async ({ result, update }) => {
			if (result.type === 'success' && result.data)
				created = { ...result.data, key: generateKey() };
			await update();
		};
</script>

<main class="mx-auto max-w-2xl space-y-6 px-4 py-6">
	<h1 class="text-lg font-semibold">dbgopher</h1>
	{#if data.user}
		<p class="text-sm">Signed in as {data.user.email}</p>

		<section class="space-y-3">
			<h2 class="font-semibold">Connectors</h2>
			{#if created}
				<pre
					class="overflow-x-auto rounded bg-muted p-3 font-mono text-xs break-all whitespace-pre-wrap">{command(
						created
					)}</pre>
				<Button href={`${resolve('/c/[id]', { id: created.id })}#key=${created.key}`}>
					Go to connector
				</Button>
			{/if}
			{#if data.connectors.length > 0}
				<ul class="divide-y rounded-md border">
					{#each data.connectors as connector (connector.id)}
						<li>
							<a
								href={resolve('/c/[id]', { id: connector.id })}
								class="flex justify-between gap-4 p-3 text-sm hover:bg-muted"
							>
								<span class="font-mono">{connector.id}</span>
								<span class="text-muted-foreground">{connector.createdAt.toLocaleString()}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
			<form method="POST" action="?/createConnector" use:enhance={create}>
				<Button type="submit">New connector</Button>
			</form>
		</section>

		<form method="POST" action="?/signOut">
			<Button type="submit" variant="outline">Sign out</Button>
		</form>
	{:else}
		<Button href={resolve('/sign-in')}>Sign in</Button>
	{/if}
</main>
