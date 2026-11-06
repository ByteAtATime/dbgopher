<script lang="ts">
	import SearchXIcon from '@lucide/svelte/icons/search-x';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Command from '#lib/components/ui/command/index.ts';
	import { formatBytes } from '#lib/format.ts';
	import type { Overview, Value } from '#lib/protocol/client.ts';
	import { formatRoute } from '#lib/route.ts';
	import { detect, normalize } from '#lib/search/detect.ts';
	import {
		execute,
		failedTables,
		preview,
		rowFilter,
		tableLabel,
		type Found,
		type Results,
		type Search
	} from '#lib/search/execute.ts';
	import { plan, singular, type Plan, type Target } from '#lib/search/plan.ts';
	import { decide } from '#lib/search/rank.ts';

	type Props = { overview: Overview | undefined; search: Search };

	type Session = {
		query: string;
		plan: Plan;
		results: Results;
		running: boolean;
		error?: Error;
	};

	const DEBOUNCE_MS = 150;

	let { overview, search }: Props = $props();

	let open = $state(false);
	let input = $state('');
	let selected = $state('');
	let session = $state.raw<Session | undefined>();
	let list = $state<HTMLElement | null>(null);
	let jumped: Plan | undefined;
	let revealed = $state.raw<Plan>();

	$effect(() => {
		const tables = overview;
		const { candidates } = detect(input);
		if (!tables || candidates.length === 0) {
			session = undefined;
			return;
		}
		const query = normalize(input).normalized;
		const planned = plan(candidates, tables);
		const controller = new AbortController();
		const update = (next: Partial<Session>) => {
			if (!controller.signal.aborted && session) session = { ...session, ...next };
		};
		const timer = setTimeout(() => {
			session = { query, plan: planned, results: { hits: [], failures: [] }, running: true };
			execute(planned.targets, search)
				.then((results) => update({ results, running: false }))
				.catch((error: unknown) =>
					update({
						running: false,
						error: error instanceof Error ? error : new Error(String(error))
					})
				);
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	});

	const decision = $derived(session && decide(session.plan.targets, session.results.hits));
	const jumping = $derived(decision?.kind === 'jump' && revealed !== session?.plan);
	const groups = $derived(decision && decision.kind !== 'none' && !jumping ? decision.groups : []);
	const failed = $derived(
		session
			? failedTables(
					session.plan.coverage,
					session.error
						? session.plan.targets
						: session.results.failures.map(({ target }) => target)
				)
			: 0
	);
	const empty = $derived(session && !session.running && !jumping && groups.length === 0);
	const tables = $derived(overview?.tables ?? []);

	const itemValue = (target: Target, index: number) =>
		[target.schema, target.table, target.column, target.comparison, target.value, index].join('\0');
	const values = $derived(
		groups.flatMap(({ hits }) =>
			hits.flatMap(({ target, rows }) => rows.map((_, index) => itemValue(target, index)))
		)
	);

	$effect(() => {
		if (!values.includes(untrack(() => selected))) selected = values[0] ?? '';
	});

	const label = (schema: string, table: string) => tableLabel(schema, table, tables);

	const primaryKey = (target: Target) =>
		tables.find(({ schema, name }) => schema === target.schema && name === target.table)
			?.primaryKey ?? [];

	const href = (target: Target, row: Found) =>
		`#${formatRoute({
			type: 'browse',
			schema: target.schema,
			table: target.table,
			filter: rowFilter(primaryKey(target), target, row)
		})}`;

	$effect(() => {
		if (!open) return;
		untrack(() => {
			if (session && jumped === session.plan) revealed = session.plan;
		});
	});

	const navigate = (hash: string) =>
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- only changing the hash so it's probably fine
		goto(new URL(hash, location.href));

	$effect(() => {
		if (!open || !session || decision?.kind !== 'jump' || jumped === session.plan) return;
		jumped = session.plan;
		const { target, rows } = decision.hit;
		const key = rowFilter(primaryKey(target), target, rows[0])
			.map(({ value }) => value)
			.join(', ');
		const previous = location.hash;
		open = false;
		let landed: string | undefined;
		void navigate(href(target, rows[0])).then(() => (landed = location.hash));
		const undo = () => {
			open = true;
			if (location.hash === landed) history.back();
			else void navigate(previous || '#');
		};
		toast(`Jumped to ${label(target.schema, target.table)} #${key}`, {
			action: { label: 'Undo', onClick: undo }
		});
	});

	const onkeydown = (event: KeyboardEvent) => {
		if (event.key === 'k' && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			open = !open;
		}
	};

	const openInNewTab = (event: KeyboardEvent) => {
		if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
		const selected = list?.querySelector<HTMLAnchorElement>('a[data-selected]');
		if (!selected) return;
		event.preventDefault();
		event.stopPropagation();
		window.open(selected.href, '_blank', 'noopener');
	};
</script>

<svelte:window {onkeydown} />

{#snippet cell(value: Value | null | undefined)}
	{#if value === null || value === undefined}
		<span class="text-muted-foreground">—</span>
	{:else if value.kind === 'binary'}
		<span class="text-muted-foreground">Binary &bull; {formatBytes(value.bytes)}</span>
	{:else}
		<span class="truncate" title={value.text}>{value.text}</span>
	{/if}
{/snippet}

<Command.Dialog
	bind:open
	bind:value={selected}
	shouldFilter={false}
	class="top-[15vh] sm:max-w-4xl"
>
	<Command.Input
		bind:value={input}
		onkeydown={openInNewTab}
		class="font-mono"
		spellcheck={false}
		autocomplete="off"
		autocapitalize="off"
	/>
	<div class="relative h-0">
		{#if session?.running || jumping}
			<div class="absolute -inset-x-1 top-0.5 h-0.5 overflow-hidden">
				<div
					class="sweep h-full w-1/3 bg-linear-to-r from-transparent via-primary to-transparent"
				></div>
			</div>
		{/if}
	</div>
	{#if groups.length > 0}
		<Command.List bind:ref={list} class="-mx-1 max-h-[min(60vh,32rem)] border-t px-1 pt-1">
			{#if session && decision?.kind === 'results' && decision.needsHint}
				<p class="px-3 py-2 text-xs text-muted-foreground">
					<code>{session.query}</code> matches an id in {groups.length} tables. Add a hint, like
					<code>{singular(groups[0].table)} {session.query}</code>
				</p>
			{/if}
			{#each groups as group (`${group.schema}.${group.table}`)}
				<Command.Group heading={label(group.schema, group.table)}>
					{#each group.hits as { target, rows } (`${target.column}\0${target.comparison}\0${target.value}`)}
						{#each rows as row, index (index)}
							<Command.LinkItem
								href={href(target, row)}
								value={itemValue(target, index)}
								onSelect={() => (open = false)}
							>
								<span class="flex min-w-0 flex-1 gap-3 font-mono text-xs">
									{#each preview(primaryKey(target), target, row) as { column, value } (column)}
										<span class="flex max-w-48 min-w-0 gap-1">
											<span class="shrink-0 text-muted-foreground">{column}</span>
											{@render cell(value)}
										</span>
									{/each}
								</span>
								<span class="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
									{#if target.candidate.source === 'url'}
										<span class="rounded border px-1">from URL</span>
									{/if}
									{#if target.comparison === 'lowerEqual'}
										<span class="rounded border px-1">case-insensitive</span>
									{/if}
									<span>matched {target.table}.{target.column}</span>
								</span>
							</Command.LinkItem>
						{/each}
					{/each}
				</Command.Group>
			{/each}
		</Command.List>
	{/if}
	{#if empty}
		<div class="flex flex-col items-center gap-2 border-t py-10 text-sm text-muted-foreground">
			<SearchXIcon class="size-6" />
			No results
		</div>
	{/if}
	{#if session && !session.running && !jumping && failed > 0}
		<p class="border-t px-3 py-2 text-xs text-destructive">
			Failed to read {failed}
			{failed === 1 ? 'table' : 'tables'}
		</p>
	{/if}
</Command.Dialog>

<style>
	.sweep {
		animation: sweep 1s ease-in-out infinite alternate;
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sweep {
			width: 100%;
			animation: none;
			opacity: 0.5;
		}
	}
</style>
