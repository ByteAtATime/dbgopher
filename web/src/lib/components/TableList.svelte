<script lang="ts">
	import { formatBytes, formatRowCount } from '#lib/format.ts';
	import type { Table as TableType } from '#lib/protocol/bindings/Table.ts';
	import * as Table from '#lib/components/ui/table/index.ts';
	import { Skeleton } from '#lib/components/ui/skeleton/index.ts';

	type Props = { tables?: TableType[] };

	let { tables }: Props = $props();
</script>

<Table.Root>
	<Table.Header>
		<Table.Row>
			<Table.Head class="text-xs text-muted-foreground">Name</Table.Head>
			<Table.Head class="text-right text-xs text-muted-foreground">Rows</Table.Head>
			<Table.Head class="pl-4 text-right text-xs text-muted-foreground">Size</Table.Head>
		</Table.Row>
	</Table.Header>
	<Table.Body>
		{#if tables}
			{#each tables as table (`${table.schema}.${table.name}`)}
				<Table.Row>
					<Table.Cell class="wrap-anywhere">
						<span class="text-muted-foreground">{table.schema}.</span>{table.name}
					</Table.Cell>
					<Table.Cell
						class="text-right tabular-nums"
						title={table.rowCountExact ? undefined : 'Estimated from table statistics'}
					>
						{formatRowCount(table.rowCount, table.rowCountExact)}
					</Table.Cell>
					<Table.Cell class="pl-4 text-right whitespace-nowrap tabular-nums">
						{table.kind === 'view' ? '—' : formatBytes(table.totalBytes)}
					</Table.Cell>
				</Table.Row>
			{:else}
				<Table.Row>
					<Table.Cell colspan={3} class="text-muted-foreground">
					    Unable to load tables
					</Table.Cell>
				</Table.Row>
			{/each}
		{:else}
			{#each { length: 8 }, index (index)}
				<Table.Row aria-hidden="true">
					<Table.Cell><Skeleton class="h-5 w-48 max-w-full" /></Table.Cell>
					<Table.Cell><Skeleton class="ml-auto h-5 w-12" /></Table.Cell>
					<Table.Cell class="pl-4"><Skeleton class="ml-auto h-5 w-14" /></Table.Cell>
				</Table.Row>
			{/each}
		{/if}
	</Table.Body>
</Table.Root>
