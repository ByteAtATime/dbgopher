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
    pub search_path: Vec<String>,
    pub restricted: Vec<TableName>,
    pub fingerprint: String,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TableName {
    pub schema: String,
    pub name: String,
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
    pub indexes: Vec<Index>,
    pub row_security: bool,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Index {
    pub name: String,
    pub method: String,
    pub unique: bool,
    pub partial: bool,
    pub key_count: u32,
    pub column: Option<String>,
    pub expression: Option<String>,
    pub expression_type: Option<String>,
    pub operator_class: String,
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
        c.relkind IN ('r', 'p', 'm') AND size.heap_bytes <= $1 AS count_exactly,
        c.relrowsecurity
            AND (c.relforcerowsecurity OR NOT pg_has_role(c.relowner, 'USAGE'))
            AND NOT EXISTS (
                SELECT FROM pg_roles r
                WHERE r.rolname = current_user AND (r.rolsuper OR r.rolbypassrls)
            ) AS row_security
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

const INDEXES: &str = "
    SELECT i.indrelid AS table_oid, ic.relname::text AS name, am.amname::text AS method,
        i.indisunique AS unique, i.indpred IS NOT NULL AS partial,
        i.indnkeyatts::int4 AS key_count,
        a.attname::text AS column,
        CASE WHEN i.indkey[0] = 0 THEN pg_get_indexdef(i.indexrelid, 1, true) END AS expression,
        CASE WHEN i.indkey[0] = 0 THEN format_type(ia.atttypid, ia.atttypmod) END
            AS expression_type,
        opc.opcname::text AS operator_class
    FROM pg_index i
    JOIN pg_class ic ON ic.oid = i.indexrelid
    JOIN pg_am am ON am.oid = ic.relam
    JOIN pg_attribute ia ON ia.attrelid = i.indexrelid AND ia.attnum = 1
    JOIN pg_opclass opc ON opc.oid = i.indclass[0]
    LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = ANY($1) AND i.indisvalid AND i.indisready AND i.indislive
    ORDER BY i.indrelid, ic.relname
";

const SEARCH_PATH: &str = "SELECT current_schemas(false)::text[] AS schemas";

const RESTRICTED: &str = "
    SELECT n.nspname::text AS schema, c.relname::text AS name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%'
        AND NOT has_table_privilege(c.oid, 'SELECT')
    ORDER BY n.nspname, c.relname
";

pub const FINGERPRINT: &str = "
    WITH relations AS (
        SELECT c.oid, c.xmin
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
    )
    SELECT concat_ws(':',
        (SELECT count(*) || '.' || coalesce(sum(xmin::text::int8), 0) FROM relations),
        (SELECT count(*) || '.' || coalesce(sum(a.xmin::text::int8), 0)
            FROM pg_attribute a JOIN relations r ON r.oid = a.attrelid),
        (SELECT count(*) || '.' || coalesce(sum(i.xmin::text::int8), 0)
            FROM pg_index i JOIN relations r ON r.oid = i.indrelid),
        (SELECT count(*) || '.' || coalesce(sum(con.xmin::text::int8), 0)
            FROM pg_constraint con JOIN relations r ON r.oid = con.conrelid),
        (SELECT count(*) || '.' || coalesce(sum(e.xmin::text::int8), 0) FROM pg_extension e),
        (SELECT count(*) || '.' || coalesce(sum(n.xmin::text::int8), 0) FROM pg_namespace n)
    ) AS fingerprint
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
    let (columns, constraints, indexes, search_path, restricted, fingerprint, counts) = tokio::try_join!(
        transaction.query(COLUMNS, &params),
        transaction.query(CONSTRAINTS, &params),
        transaction.query(INDEXES, &params),
        transaction.query_one(SEARCH_PATH, &[]),
        transaction.query(RESTRICTED, &[]),
        transaction.query_one(FINGERPRINT, &[]),
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
    for row in &indexes {
        let table = &mut tables[positions[&row.get("table_oid")]];
        table.indexes.push(Index::from(row));
    }
    Ok(Overview {
        tables,
        search_path: search_path.get("schemas"),
        restricted: restricted
            .iter()
            .map(|row| TableName {
                schema: row.get("schema"),
                name: row.get("name"),
            })
            .collect(),
        fingerprint: fingerprint.get("fingerprint"),
    })
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

pub fn quote_identifier(identifier: &str) -> String {
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
            indexes: Vec::new(),
            row_security: row.get("row_security"),
        }
    }
}

impl From<&Row> for Index {
    fn from(row: &Row) -> Self {
        Self {
            name: row.get("name"),
            method: row.get("method"),
            unique: row.get("unique"),
            partial: row.get("partial"),
            key_count: row.get::<_, i32>("key_count").unsigned_abs(),
            column: row.get("column"),
            expression: row.get("expression"),
            expression_type: row.get("expression_type"),
            operator_class: row.get("operator_class"),
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
