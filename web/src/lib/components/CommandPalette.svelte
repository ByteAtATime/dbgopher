<script lang="ts">
	import * as Command from '#lib/components/ui/command/index.ts';

	let open = $state(false);

	const onkeydown = (event: KeyboardEvent) => {
		if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			open = !open;
		}
	};
</script>

<svelte:window {onkeydown} />

<Command.Dialog bind:open shouldFilter={false} class="top-[15vh] sm:max-w-2xl">
	<Command.Input class="font-mono" spellcheck={false} autocomplete="off" autocapitalize="off" />
	<Command.List class="-mx-1 max-h-[min(60vh,32rem)] border-t px-1 pt-1 empty:hidden" />
</Command.Dialog>
