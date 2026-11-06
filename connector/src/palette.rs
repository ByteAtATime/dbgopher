use std::collections::HashMap;
use std::task::Poll;
use std::time::Duration;

use futures_util::future::{join, try_join3};
use futures_util::poll;
use serde::{Deserialize, Serialize};
use tokio_postgres::Client;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Type;
use ts_rs::TS;

use crate::browse::{self, Filter, Rows, VALUES};
use crate::database::{self, Database};
use crate::overview::{Column, quote_identifier};

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "PaletteTarget")]
pub struct Target {
    pub schema: String,
    pub table: String,
    #[serde(flatten)]
    #[ts(flatten)]
    pub filter: Filter,
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Palette {
    pub outcomes: Vec<Outcome>,
}

#[derive(Debug, Serialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, rename = "PaletteOutcome")]
pub enum Outcome {
    Rows(Rows),
    TimedOut,
    Denied,
    Failed { message: String },
}

pub const LIMIT: u32 = 6;

const TARGET_TIMEOUT: Duration = Duration::from_millis(1500);
const SEARCH_BUDGET: Duration = Duration::from_secs(10);
const VALUE_PARAMETER: usize = 1;

const CATALOG: &str = "
    SELECT n.nspname::text AS schema, c.relname::text AS relation, a.attname::text AS name,
        a.atttypid AS type_oid, format_type(a.atttypid, a.atttypmod) AS type_name,
        NOT a.attnotnull AS nullable, a.atthasdef OR a.attidentity <> '' AS has_default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname, c.relname) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attrelid, a.attnum
";

type Catalog = HashMap<String, HashMap<String, Vec<Column>>>;

pub async fn search(database: &Database, targets: &[Target]) -> Result<Palette, database::Error> {
    let target_count = u32::try_from(targets.len()).unwrap_or(u32::MAX).max(1);
    let timeout = (SEARCH_BUDGET / target_count)
        .min(TARGET_TIMEOUT)
        .as_millis()
        .max(1);
    let settings =
        format!("SET LOCAL statement_timeout = '{timeout}ms'; SET LOCAL lock_timeout = '100ms';");
    database
        .read_pipelined(&settings, async |client| {
            let catalog = catalog(client, targets).await?;
            run(client, &catalog, targets).await
        })
        .await
}

async fn catalog(client: &Client, targets: &[Target]) -> Result<Catalog, tokio_postgres::Error> {
    let (schemas, names): (Vec<&str>, Vec<&str>) = targets
        .iter()
        .map(|target| (target.schema.as_str(), target.table.as_str()))
        .unzip();
    let rows = client
        .query_typed(
            CATALOG,
            &[(&schemas, Type::TEXT_ARRAY), (&names, Type::TEXT_ARRAY)],
        )
        .await?;
    let mut catalog = Catalog::new();
    for row in &rows {
        catalog
            .entry(row.get("schema"))
            .or_default()
            .entry(row.get("relation"))
            .or_default()
            .push(Column::from(row));
    }
    Ok(catalog)
}

async fn run(
    client: &Client,
    catalog: &Catalog,
    targets: &[Target],
) -> Result<Palette, tokio_postgres::Error> {
    let searches = targets.iter().map(|target| {
        let columns = catalog
            .get(&target.schema)
            .and_then(|tables| tables.get(&target.table))
            .cloned()
            .unwrap_or_default();
        search_target(client, target, columns)
    });
    let (_, outcomes, _) = try_join3(
        client.batch_execute("SAVEPOINT target"),
        async { in_order(searches).await.into_iter().collect() },
        client.batch_execute("COMMIT"),
    )
    .await?;
    Ok(Palette { outcomes })
}

async fn search_target(
    client: &Client,
    target: &Target,
    columns: Vec<Column>,
) -> Result<Outcome, tokio_postgres::Error> {
    let codecs = browse::codecs(&columns);
    let query = format!(
        "SELECT {VALUES} AS values
        FROM (SELECT {} FROM {}.{} source WHERE {} LIMIT {LIMIT}) t",
        browse::projection(&columns, &codecs),
        quote_identifier(&target.schema),
        quote_identifier(&target.table),
        browse::condition(&columns, &target.filter, VALUE_PARAMETER),
    );
    let (found, rollback) = join(
        client.query_typed(&query, &[(&target.filter.value, Type::TEXT)]),
        client.batch_execute("ROLLBACK TO SAVEPOINT target"),
    )
    .await;
    rollback?;
    Ok(match found {
        Ok(rows) => Outcome::Rows(Rows {
            columns,
            rows: rows
                .iter()
                .map(|row| browse::decode(row.get("values"), &codecs))
                .collect(),
        }),
        Err(error) => Outcome::from(error),
    })
}

async fn in_order<F: Future>(futures: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    let mut futures: Vec<_> = futures.into_iter().map(Box::pin).collect();
    let mut polled = Vec::with_capacity(futures.len());
    for future in &mut futures {
        polled.push(poll!(future.as_mut()));
    }
    let mut outputs = Vec::with_capacity(futures.len());
    for (future, polled) in futures.into_iter().zip(polled) {
        outputs.push(match polled {
            Poll::Ready(output) => output,
            Poll::Pending => future.await,
        });
    }
    outputs
}

impl From<tokio_postgres::Error> for Outcome {
    fn from(error: tokio_postgres::Error) -> Self {
        match error.code() {
            Some(&SqlState::QUERY_CANCELED | &SqlState::LOCK_NOT_AVAILABLE) => Self::TimedOut,
            Some(&SqlState::INSUFFICIENT_PRIVILEGE) => Self::Denied,
            _ => Self::Failed {
                message: database::Error::from(error).describe(),
            },
        }
    }
}
