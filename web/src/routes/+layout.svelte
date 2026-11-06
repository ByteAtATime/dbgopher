<script lang="ts">
	import './layout.css';
	import { Toaster } from '#lib/components/ui/sonner/index.ts';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<Toaster />

{@render children()}
