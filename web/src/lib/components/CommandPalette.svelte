<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { Command as CommandPrimitive } from 'bits-ui';
	import { untrack } from 'svelte';
	import * as Command from '#lib/components/ui/command/index.ts';
	import * as Dialog from '#lib/components/ui/dialog/index.ts';
	import { formatRowCount } from '#lib/format.ts';
	import type { Palette } from '#lib/palette.svelte.ts';
	import type { Table } from '#lib/protocol/bindings/Table.ts';
	import type { Detector } from '#lib/search/detect.ts';
	import { preview, tableLabel } from '#lib/search/preview.ts';
	import type { Hit } from '#lib/search/rank.ts';
	import { singular, tableKey } from '#lib/search/scope.ts';
	import { cn } from '#lib/utils.js';

	type Props = {
		palette: Palette;
		tables: Table[];
		open: boolean;
		onselect: (hit: Hit, newTab: boolean) => void;
		onjump: (hit: Hit) => void;
	};

	const PLACEHOLDER = 'Paste an ID, email or URL';

	const LABELS: Record<Detector, string> = {
		uuid: 'UUID',
		email: 'Email',
		url: 'URL',
		prefixed: 'Prefixed ID',
		integer: 'Integer',
		timestamp: 'Timestamp or date',
		ip: 'IP or CIDR',
		phone: 'Phone',
		text: 'Text'
	};

	let { palette, tables, open = $bindable(), onselect, onjump }: Props = $props();

	let selected = $state('');
	let input = $state<HTMLInputElement | null>(null);
	let expanded = $state(false);
	let followTop = true;

	const NAVIGATION = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End']);

	const ranking = $derived(palette.ranking);
	const analysis = $derived(palette.analysis);
	const plan = $derived(analysis?.plan);
	const empty = $derived(palette.input.trim() === '');
	const hits = $derived(
		new Map(ranking?.groups.flatMap(({ hits }) => hits.map((hit) => [hit.key, hit])))
	);
	const skippedColumns = $derived(
		plan?.skipped.reduce((sum, { columns }) => sum + columns.length, 0) ?? 0
	);
	const notPermitted = $derived((plan?.restricted ?? 0) + (ranking?.denied ?? 0));
	const noHits = $derived(ranking?.done === true && ranking.groups.length === 0);

	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
	const label = (table: Table) => tableLabel(table, tables);

	const referenced = (hit: Hit) =>
		hit.related
			.map(({ table, count, truncated }) => {
				const name = count === 1 && !truncated ? singular(table.name) : table.name;
				return `${truncated ? '5+' : count} ${name}`;
			})
			.join(' and ')
			.replace(/ and (?=.* and )/g, ', ');

	$effect(() => {
		if (!open) return;
		palette.resume();
		requestAnimationFrame(() => input?.select());
		return () => palette.pause();
	});

	$effect(() => {
		const first = ranking?.groups[0]?.hits[0]?.key;
		const keys = hits;
		untrack(() => {
			if (first !== undefined && (followTop || !keys.has(selected))) selected = first;
		});
	});

	$effect(() => {
		if (!open || !ranking?.jump) return;
		const jump = palette.takeJump();
		if (jump) onjump(jump);
	});

	const onkeydown = (event: KeyboardEvent) => {
		if (NAVIGATION.has(event.key)) followTop = false;
		if (event.key === 'Tab' && palette.interpretations.length > 0) {
			event.preventDefault();
			palette.cycle(event.shiftKey ? -1 : 1);
		} else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			const hit = hits.get(selected);
			if (!hit) return;
			event.preventDefault();
			event.stopPropagation();
			onselect(hit, true);
		}
	};

	const onpaste = (event: ClipboardEvent & { currentTarget: HTMLInputElement }) => {
		const lines = (event.clipboardData?.getData('text/plain') ?? '')
			.split(/\r\n|\r|\n/)
			.filter((line) => line.trim() !== '');
		if (lines.length < 2) return;
		event.preventDefault();
		const { value, selectionStart, selectionEnd } = event.currentTarget;
		followTop = true;
		palette.setInput(
			`${value.slice(0, selectionStart ?? value.length)}${lines[0]}${value.slice(selectionEnd ?? value.length)}`,
			true,
			true
		);
	};

	const oninput = (event: Event & { currentTarget: HTMLInputElement }) => {
		followTop = true;
		palette.setInput(
			event.currentTarget.value,
			event instanceof InputEvent && event.inputType === 'insertFromPaste'
		);
	};
</script>

<Dialog.Root bind:open>
	<Dialog.Content
		class="top-[15%] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl"
		showCloseButton={false}
	>
		<Dialog.Title class="sr-only">{PLACEHOLDER}</Dialog.Title>
		<Command.Root
			shouldFilter={false}
			vimBindings={false}
			label={PLACEHOLDER}
			loop
			bind:value={selected}
			class="rounded-none! p-0"
		>
			<div class="flex items-center gap-2 border-b px-3">
				<SearchIcon class="size-4 shrink-0 text-muted-foreground" />
				<CommandPrimitive.Input
					bind:ref={input}
					class="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					placeholder={PLACEHOLDER}
					value={palette.input}
					autocomplete="off"
					spellcheck="false"
					{oninput}
					{onpaste}
					{onkeydown}
				/>
				{#if palette.interpretations.length > 1}
					<div class="flex shrink-0 items-center gap-1">
						{#each palette.interpretations as { detector } (detector)}
							<button
								type="button"
								tabindex="-1"
								class={cn(
									'rounded-sm border px-1.5 py-0.5 text-xs transition-colors',
									palette.detector === detector
										? 'border-primary/60 bg-primary-soft text-primary'
										: palette.detector === null
											? 'text-muted-foreground hover:text-foreground'
											: 'border-transparent text-faint-foreground hover:text-foreground'
								)}
								onclick={() => palette.choose(palette.detector === detector ? null : detector)}
							>
								{LABELS[detector]}
							</button>
						{/each}
					</div>
				{/if}
			</div>
			<div class="relative h-0.5 overflow-hidden">
				<div
					class={cn(
						'absolute inset-y-0 left-0 bg-primary transition-[width,opacity] duration-200',
						palette.searching ? 'animate-pulse opacity-100' : 'opacity-0'
					)}
					style:width={`${Math.max(palette.progress, 0.08) * 100}%`}
				></div>
			</div>

			{#if !empty && palette.multiline}
				<p class="px-3 pt-2 text-xs text-muted-foreground">Searched the first line only</p>
			{/if}

			{#if !empty && ranking}
				<Command.List
					aria-label={PLACEHOLDER}
					onpointermove={() => (followTop = false)}
					class={cn(
						'max-h-[min(60vh,32rem)] px-1 transition-opacity',
						palette.stale && 'opacity-60'
					)}
				>
					{#if ranking.weak}
						<p class="px-3 py-2 text-xs text-muted-foreground">
							<code class="font-mono text-foreground">{analysis?.query}</code> matches an id in {ranking
								.weak.tables} tables. Add a hint, like
							<button
								type="button"
								class="font-mono text-foreground underline decoration-dotted underline-offset-2"
								onclick={() => {
									if (ranking.weak) palette.setInput(ranking.weak.example, true);
									input?.focus();
								}}>{ranking.weak.example}</button
							>
						</p>
					{/if}
					{#each ranking.groups as group (tableKey(group.table))}
						<Command.Group heading={label(group.table)}>
							{#each group.hits as hit (hit.key)}
								{@const reason = hit.reasons[0]}
								{@const values = preview(hit)}
								<Command.Item
									value={hit.key}
									onSelect={() => onselect(hit, false)}
									class="flex-col items-stretch gap-0.5"
								>
									<div class="flex min-w-0 items-baseline gap-2">
										{#if hit.identity !== undefined}
											<span class="shrink-0 font-mono text-xs text-foreground">{hit.identity}</span>
										{/if}
										<span class="min-w-0 flex-1 truncate">
											{#each values as { column, value }, index (column)}
												{#if index > 0}<span class="text-faint-foreground">&#32;·&#32;</span>{/if}
												<span title={column}>{value}</span>
											{/each}
										</span>
										<span class="flex shrink-0 items-center gap-1">
											{#if reason.target.caseInsensitive}
												<span class="rounded-sm bg-muted px-1 text-[0.7rem] text-muted-foreground"
													>case-insensitive</span
												>
											{/if}
											{#if reason.target.partialKey}
												<span class="rounded-sm bg-muted px-1 text-[0.7rem] text-muted-foreground"
													>partial key</span
												>
											{/if}
											{#if reason.truncated}
												<span class="rounded-sm bg-muted px-1 text-[0.7rem] text-muted-foreground"
													>5+ matches</span
												>
											{/if}
										</span>
									</div>
									<div class="truncate text-xs text-muted-foreground">
										matched {label(hit.table)}.{reason.target.column}{reason.target.candidate
											.via === 'url'
											? ' (via URL)'
											: ''}{#if hit.related.length > 0}<span class="text-faint-foreground"
												>&#32;·&#32;</span
											>also referenced by {referenced(hit)}{/if}
									</div>
								</Command.Item>
							{/each}
						</Command.Group>
					{/each}
				</Command.List>

				{#if ranking.done && plan}
					<div
						class={cn(
							'border-t px-3 py-2',
							noHits ? 'text-sm text-foreground' : 'text-xs text-muted-foreground'
						)}
					>
						<p class="flex flex-wrap items-center gap-x-1">
							<span
								>Searched {plural(plan.searched.columns, 'column')} in {plural(
									plan.searched.tables,
									'table'
								)}</span
							>
							{#if plan.skipped.length > 0}
								<span class="text-faint-foreground">·</span>
								<button
									type="button"
									class="inline-flex items-center gap-0.5 hover:text-foreground"
									aria-expanded={expanded}
									onclick={() => (expanded = !expanded)}
								>
									<ChevronRightIcon
										class={cn('size-3 transition-transform', expanded && 'rotate-90')}
									/>
									skipped {skippedColumns} unindexed {skippedColumns === 1 ? 'column' : 'columns'} on
									large tables
								</button>
								<span
									>(<button
										type="button"
										class="underline decoration-dotted underline-offset-2 hover:text-foreground"
										onclick={() => palette.optIn(plan.skipped.map(({ table }) => tableKey(table)))}
										>search anyway</button
									>)</span
								>
							{/if}
							{#if plan.extrasSkipped > 0}
								<span class="text-faint-foreground">·</span>
								<span
									>skipped fuzzy and jsonb matching on {plan.extrasSkipped} large {plan.extrasSkipped ===
									1
										? 'table'
										: 'tables'}</span
								>
							{/if}
							{#if notPermitted > 0}
								<span class="text-faint-foreground">·</span>
								<span>{plural(notPermitted, 'table')} not permitted</span>
							{/if}
							{#if ranking.timedOut > 0}
								<span class="text-faint-foreground">·</span>
								<span
									>{ranking.timedOut} timed out (<button
										type="button"
										class="underline decoration-dotted underline-offset-2 hover:text-foreground"
										onclick={palette.retry}>retry</button
									>)</span
								>
							{/if}
							{#if plan.rowSecurity > 0}
								<span class="text-faint-foreground">·</span>
								<span>RLS active on {plural(plan.rowSecurity, 'table')}</span>
							{/if}
							{#each ranking.failed as { table, message } (tableKey(table))}
								<span class="text-faint-foreground">·</span>
								<span class="text-destructive">{label(table)}: {message}</span>
							{/each}
						</p>
						{#if expanded && plan.skipped.length > 0}
							<ul class="mt-1.5 space-y-0.5 text-xs">
								{#each plan.skipped as { table, columns } (tableKey(table))}
									<li class="flex items-center justify-between gap-3">
										<span class="truncate font-mono text-muted-foreground">
											{label(table)}.{columns.join(', ')}
										</span>
										<button
											type="button"
											class="shrink-0 text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
											onclick={() => palette.optIn([tableKey(table)])}
										>
											Scans {formatRowCount(table.rowCount, table.rowCountExact)} rows
										</button>
									</li>
								{/each}
							</ul>
						{/if}
						{#if noHits && plan.insensitive}
							<button
								type="button"
								class="mt-1.5 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
								onclick={palette.searchInsensitive}
							>
								Search case-insensitively
							</button>
						{/if}
					</div>
				{/if}
			{/if}
		</Command.Root>
	</Dialog.Content>
</Dialog.Root>
