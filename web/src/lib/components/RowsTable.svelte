<script lang="ts">
	import type { Browse } from '#lib/protocol/client.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';
	import { formatBytes } from '#lib/format.ts';

	type Props = { columns: string[]; rows?: Browse };

	let { columns, rows }: Props = $props();

	const headers = $derived(rows?.columns.map((column) => column.name) ?? columns);
</script>

<Table.Root>
	<Table.Header>
		<Table.Row>
			{#each headers as header, index (index)}
				<Table.Head class="text-xs text-muted-foreground">{header}</Table.Head>
			{/each}
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#if rows}
			{#each rows.rows as row, index (index)}
				<Table.Row>
					{#each row as value, column (column)}
						<Table.Cell
							class="max-w-xs truncate font-mono text-xs"
							title={value?.kind === 'text' ? value.text : undefined}
						>
							{#if value === null}
								<span class="text-muted-foreground">—</span>
							{:else if value.kind === 'binary'}
								<span class="text-muted-foreground"
									>Binary &bull; {formatBytes(value.bytes)}</span
								>
							{:else}
								{value.text}
							{/if}
						</Table.Cell>
					{/each}
				</Table.Row>
			{/each}
		{:else}
			{#each { length: 8 }, index (index)}
				<Table.Row aria-hidden="true">
					{#each { length: headers.length }, column (column)}
						<Table.Cell><Skeleton class="h-5 w-20" /></Table.Cell>
					{/each}
				</Table.Row>
			{/each}
		{/if}
	</Table.Body>
</Table.Root>
