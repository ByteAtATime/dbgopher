use serde::{Deserialize, Serialize};
use tokio_postgres::Transaction;
use tokio_postgres::types::ToSql;
use ts_rs::TS;

use crate::codec::{Cell, Codec};
use crate::overview::{Column, quote_identifier};

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Rows {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<Option<Cell>>>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Sort {
    pub column: String,
    pub direction: Direction,
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Direction {
    Asc,
    Desc,
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
    sort: Option<&Sort>,
) -> Result<Rows, tokio_postgres::Error> {
    let names: [&(dyn ToSql + Sync); 2] = [&schema, &table];
    let columns: Vec<Column> = transaction
        .query(COLUMNS, &names)
        .await?
        .iter()
        .map(Column::from)
        .collect();
    let codecs: Vec<Codec> = columns
        .iter()
        .map(|column| Codec::for_type(column.type_oid))
        .collect();
    let projection = columns
        .iter()
        .zip(&codecs)
        .map(|(column, codec)| codec.select(&column.name))
        .collect::<Vec<_>>()
        .join(", ");
    let order = sort
        .map(|sort| {
            let direction = match sort.direction {
                Direction::Asc => "ASC",
                Direction::Desc => "DESC",
            };
            format!(
                "ORDER BY source.{} {direction}",
                quote_identifier(&sort.column)
            )
        })
        .unwrap_or_default();
    let query = format!(
        "SELECT array(
            SELECT value FROM json_each_text(row_to_json(t)) WITH ORDINALITY ORDER BY ordinality
        ) AS values
        FROM (SELECT {projection} FROM {}.{} source {order} LIMIT $1 OFFSET $2) t",
        quote_identifier(schema),
        quote_identifier(table)
    );
    let (limit, offset) = (i64::from(limit), i64::from(offset));
    let page: [&(dyn ToSql + Sync); 2] = [&limit, &offset];
    let rows = transaction.query(&query, &page).await?;
    Ok(Rows {
        columns,
        rows: rows
            .iter()
            .map(|row| {
                row.get::<_, Vec<Option<String>>>("values")
                    .into_iter()
                    .zip(&codecs)
                    .map(|(value, codec)| value.map(|value| codec.decode(value)))
                    .collect()
            })
            .collect(),
    })
}
