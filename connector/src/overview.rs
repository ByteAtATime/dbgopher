use std::collections::HashMap;

use futures_util::future::try_join_all;
use serde::Serialize;
use tokio_postgres::types::ToSql;
use tokio_postgres::{Row, Transaction};
use ts_rs::TS;

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Overview {
    pub tables: Vec<Table>,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Table {
    pub schema: String,
    pub name: String,
    pub kind: TableKind,
    #[ts(type = "number | null")]
    pub row_count: Option<i64>,
    pub row_count_exact: bool,
    #[ts(type = "number")]
    pub total_bytes: i64,
    pub columns: Vec<Column>,
    pub primary_key: Vec<String>,
    pub foreign_keys: Vec<ForeignKey>,
}

#[derive(Debug, Clone, Copy, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum TableKind {
    Table,
    PartitionedTable,
    View,
    MaterializedView,
    ForeignTable,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Column {
    pub name: String,
    pub type_oid: u32,
    pub type_name: String,
    pub nullable: bool,
    pub has_default: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ForeignKey {
    pub name: String,
    pub columns: Vec<String>,
    pub referenced_schema: String,
    pub referenced_table: String,
    pub referenced_columns: Vec<String>,
}

const TABLES: &str = "
    SELECT c.oid, n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS kind,
        CASE WHEN c.relkind <> 'v' AND c.reltuples >= 0 THEN c.reltuples::int8 END AS estimated_rows,
        size.total_bytes,
        c.relkind IN ('r', 'p', 'm') AND size.heap_bytes <= $1 AS count_exactly
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL (
        SELECT coalesce(sum(pg_total_relation_size(r.relid)), 0)::int8 AS total_bytes,
            coalesce(sum(pg_relation_size(r.relid)), 0)::int8 AS heap_bytes
        FROM (
            SELECT relid FROM pg_partition_tree(c.oid) WHERE c.relkind = 'p'
            UNION ALL
            SELECT c.oid::regclass WHERE c.relkind <> 'p'
        ) r
    ) size
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND NOT c.relispartition
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%'
        AND has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname
";

const COLUMNS: &str = "
    SELECT a.attrelid AS table_oid, a.attname::text AS name, a.atttypid AS type_oid,
        format_type(a.atttypid, a.atttypmod) AS type_name,
        NOT a.attnotnull AS nullable,
        a.atthasdef OR a.attidentity <> '' AS has_default
    FROM pg_attribute a
    WHERE a.attrelid = ANY($1) AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum
";

const CONSTRAINTS: &str = "
    SELECT con.conrelid AS table_oid, con.contype::text AS kind, con.conname::text AS name,
        array(
            SELECT a.attname::text
            FROM unnest(con.conkey) WITH ORDINALITY k(attnum, position)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            ORDER BY k.position
        ) AS columns,
        rn.nspname::text AS referenced_schema,
        rc.relname::text AS referenced_table,
        array(
            SELECT a.attname::text
            FROM unnest(con.confkey) WITH ORDINALITY k(attnum, position)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
            ORDER BY k.position
        ) AS referenced_columns
    FROM pg_constraint con
    LEFT JOIN pg_class rc ON rc.oid = con.confrelid
    LEFT JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    WHERE con.conrelid = ANY($1) AND con.contype IN ('p', 'f') AND con.conparentid = 0
    ORDER BY con.conrelid, con.conname
";

const EXACT_COUNT_MAX_HEAP_BYTES: i64 = 16 * 1024 * 1024;

pub async fn load(transaction: &Transaction<'_>) -> Result<Overview, tokio_postgres::Error> {
    let rows = transaction
        .query(TABLES, &[&EXACT_COUNT_MAX_HEAP_BYTES])
        .await?;
    let mut tables = rows.iter().map(Table::from).collect::<Vec<_>>();
    let oids = rows.iter().map(|row| row.get("oid")).collect::<Vec<u32>>();
    let exact = (0..rows.len())
        .filter(|&position| rows[position].get("count_exactly"))
        .collect::<Vec<_>>();

    let params: [&(dyn ToSql + Sync); 1] = [&oids];
    let (columns, constraints, counts) = tokio::try_join!(
        transaction.query(COLUMNS, &params),
        transaction.query(CONSTRAINTS, &params),
        try_join_all(
            exact
                .iter()
                .map(|&position| count_rows(transaction, &tables[position]))
        ),
    )?;

    for (position, count) in exact.into_iter().zip(counts) {
        tables[position].row_count = Some(count);
        tables[position].row_count_exact = true;
    }
    let positions = oids.into_iter().zip(0..).collect::<HashMap<_, usize>>();
    for row in &columns {
        let table = &mut tables[positions[&row.get("table_oid")]];
        table.columns.push(Column::from(row));
    }
    for row in &constraints {
        let table = &mut tables[positions[&row.get("table_oid")]];
        match row.get("kind") {
            "p" => table.primary_key = row.get("columns"),
            _ => table.foreign_keys.push(ForeignKey::from(row)),
        }
    }
    Ok(Overview { tables })
}

async fn count_rows(
    transaction: &Transaction<'_>,
    table: &Table,
) -> Result<i64, tokio_postgres::Error> {
    let query = format!(
        "SELECT count(*) FROM {}.{}",
        quote_identifier(&table.schema),
        quote_identifier(&table.name)
    );
    Ok(transaction.query_one(&query, &[]).await?.get(0))
}

fn quote_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

impl From<&Row> for Table {
    fn from(row: &Row) -> Self {
        Self {
            schema: row.get("schema"),
            name: row.get("name"),
            kind: TableKind::from_relkind(row.get("kind")),
            row_count: row.get("estimated_rows"),
            row_count_exact: false,
            total_bytes: row.get("total_bytes"),
            columns: Vec::new(),
            primary_key: Vec::new(),
            foreign_keys: Vec::new(),
        }
    }
}

impl From<&Row> for Column {
    fn from(row: &Row) -> Self {
        Self {
            name: row.get("name"),
            type_oid: row.get("type_oid"),
            type_name: row.get("type_name"),
            nullable: row.get("nullable"),
            has_default: row.get("has_default"),
        }
    }
}

impl From<&Row> for ForeignKey {
    fn from(row: &Row) -> Self {
        Self {
            name: row.get("name"),
            columns: row.get("columns"),
            referenced_schema: row.get("referenced_schema"),
            referenced_table: row.get("referenced_table"),
            referenced_columns: row.get("referenced_columns"),
        }
    }
}

impl TableKind {
    fn from_relkind(relkind: &str) -> Self {
        match relkind {
            "p" => Self::PartitionedTable,
            "v" => Self::View,
            "m" => Self::MaterializedView,
            "f" => Self::ForeignTable,
            _ => Self::Table,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_identifiers() {
        assert_eq!(quote_identifier("users"), "\"users\"");
        assert_eq!(quote_identifier("Odd \"name\""), "\"Odd \"\"name\"\"\"");
    }
}
