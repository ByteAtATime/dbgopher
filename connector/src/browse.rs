use serde::Serialize;
use tokio_postgres::Transaction;
use tokio_postgres::types::ToSql;
use ts_rs::TS;

use crate::overview::{Column, quote_identifier};

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Rows {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<String>>>,
}

pub const DEFAULT_LIMIT: u32 = 500;

const COLUMNS: &str = "
    SELECT a.attname::text AS name, a.atttypid AS type_oid,
        format_type(a.atttypid, a.atttypmod) AS type_name,
        NOT a.attnotnull AS nullable,
        a.atthasdef OR a.attidentity <> '' AS has_default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum
";

pub async fn load(
    transaction: &Transaction<'_>,
    schema: &str,
    table: &str,
    limit: u32,
    offset: u32,
) -> Result<Rows, tokio_postgres::Error> {
    let query = format!(
        "SELECT array(
            SELECT value FROM json_each_text(row_to_json(t)) WITH ORDINALITY ORDER BY ordinality
        ) AS values
        FROM {}.{} t
        LIMIT $1 OFFSET $2",
        quote_identifier(schema),
        quote_identifier(table)
    );
    let (limit, offset) = (i64::from(limit), i64::from(offset));
    let names: [&(dyn ToSql + Sync); 2] = [&schema, &table];
    let page: [&(dyn ToSql + Sync); 2] = [&limit, &offset];
    let (columns, rows) = tokio::try_join!(
        transaction.query(COLUMNS, &names),
        transaction.query(&query, &page),
    )?;
    Ok(Rows {
        columns: columns.iter().map(Column::from).collect(),
        rows: rows.iter().map(|row| row.get("values")).collect(),
    })
}
