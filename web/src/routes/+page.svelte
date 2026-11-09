<script lang="ts">
	import { resolve } from '$app/paths';
	import Timestamp from '#lib/components/Timestamp.svelte';
	import * as Tooltip from '#lib/components/ui/tooltip/index.ts';
	import { instantOf } from '#lib/timestamp.ts';
	import { Button } from '#lib/components/ui/button/index.ts';
	import { environments } from '#lib/environments.ts';
	import { forgetVault } from '#lib/vault.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<main class="mx-auto max-w-2xl space-y-6 px-4 py-6">
	<h1 class="text-lg font-semibold">dbgopher</h1>
	{#if data.user}
		<p class="text-sm">Signed in as {data.user.email}</p>

		<section class="space-y-3">
			<h2 class="font-semibold">Connectors</h2>
			{#if data.connectors.length > 0}
				<Tooltip.Provider>
					<ul class="grid grid-cols-[1fr_auto_auto] divide-y rounded-md border">
						{#each data.connectors as connector (connector.id)}
							<li class="col-span-3 grid grid-cols-subgrid">
								<a
									href={resolve('/c/[id]', { id: connector.id })}
									class="col-span-3 grid grid-cols-subgrid items-center gap-4 p-3 text-sm hover:bg-muted"
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
									<span
										class="justify-self-start rounded-md px-2 py-0.5 text-xs font-medium {environments[
											connector.environment
										].badge}">{environments[connector.environment].label}</span
									>
									<span class="text-muted-foreground"
										><Timestamp instant={instantOf(connector.createdAt)} /></span
									>
								</a>
							</li>
						{/each}
					</ul>
				</Tooltip.Provider>
			{/if}
			<Button href={resolve('/connectors/new')}>New connector</Button>
		</section>

		<form method="POST" action="?/signOut" onsubmit={() => data.user && forgetVault(data.user.id)}>
			<Button type="submit" variant="outline">Sign out</Button>
		</form>
	{:else}
		<Button href={resolve('/sign-in')}>Sign in</Button>
	{/if}
</main>
