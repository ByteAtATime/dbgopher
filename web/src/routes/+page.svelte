<script lang="ts">
	import { resolve } from '$app/paths';
	import { Button } from '#lib/components/ui/button/index.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<main class="mx-auto max-w-md space-y-4 px-4">
	<h1 class="text-lg font-semibold">dbgopher</h1>
	{#if data.user}
		<p class="text-sm">Signed in as {data.user.email}</p>
		<form method="POST" action="?/signOut">
			<Button type="submit" variant="outline">Sign out</Button>
		</form>
	{:else}
		<Button href={resolve('/sign-in')}>Sign in</Button>
	{/if}
</main>
