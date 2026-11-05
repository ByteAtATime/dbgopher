use std::collections::HashMap;
use std::sync::Mutex;

use deadpool_postgres::{Object, Pool};
use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres_rustls::MakeRustlsConnect;
use ts_rs::TS;
use uuid::Uuid;

use crate::codec::{Cell, Codec};
use crate::database::Error;
use crate::overview::{FINGERPRINT, quote_identifier};

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Probe {
    pub schema: String,
    pub table: String,
    pub conditions: Vec<Condition>,
}

#[derive(Debug, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Condition {
    Equal {
        column: String,
        value: String,
    },
    Range {
        column: String,
        from: String,
        to: String,
    },
    Insensitive {
        column: String,
        value: String,
    },
    Index {
        index: String,
        value: String,
    },
    Trigram {
        column: String,
        value: String,
    },
    Json {
        column: String,
        value: String,
        number: bool,
    },
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SearchResults {
    pub fingerprint: Option<String>,
    pub results: Vec<ProbeResult>,
}

#[derive(Debug, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ProbeResult {
    Rows {
        columns: Vec<String>,
        hits: Vec<Hit>,
        limit: u32,
    },
    TimedOut,
    Denied,
    Cancelled,
    Failed {
        message: String,
    },
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hit {
    pub cells: Vec<Option<Cell>>,
    pub matched: Vec<bool>,
}

const CATALOG: &str = "
    SELECT n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS kind,
        has_table_privilege(c.oid, 'SELECT') AS readable,
        array(
            SELECT a.attname::text FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
        ) AS column_names,
        array(
            SELECT a.atttypid FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
        ) AS column_types,
        array(
            SELECT format_type(a.atttypid, NULL) FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
        ) AS column_type_names,
        array(
            SELECT ic.relname::text FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
            WHERE i.indrelid = c.oid AND i.indkey[0] = 0 ORDER BY ic.relname
        ) AS index_names,
        array(
            SELECT pg_get_indexdef(i.indexrelid, 1, false)
            FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
            WHERE i.indrelid = c.oid AND i.indkey[0] = 0 ORDER BY ic.relname
        ) AS index_expressions,
        array(
            SELECT format_type(ia.atttypid, NULL)
            FROM pg_index i
            JOIN pg_class ic ON ic.oid = i.indexrelid
            JOIN pg_attribute ia ON ia.attrelid = i.indexrelid AND ia.attnum = 1
            WHERE i.indrelid = c.oid AND i.indkey[0] = 0 ORDER BY ic.relname
        ) AS index_types,
        (
            SELECT quote_ident(en.nspname) FROM pg_extension e
            JOIN pg_namespace en ON en.oid = e.extnamespace
            WHERE e.extname = 'pg_trgm'
        ) AS trigram_schema
    FROM unnest($1::text[], $2::text[]) wanted(schema, name)
    JOIN pg_namespace n ON n.nspname = wanted.schema
    JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = wanted.name
";

pub const SESSION: &str = "
    SET default_transaction_read_only = on;
    SET statement_timeout = '1500ms';
    SET lock_timeout = '100ms';
    SET idle_in_transaction_session_timeout = '5s'
";

pub const CLIENT_CHECK: &str = "SET client_connection_check_interval = '250ms'";

const ROWS_PER_CONDITION: u32 = 6;
const MAX_ROWS: u32 = 60;
pub const PARALLELISM: usize = 4;

struct Column {
    name: String,
    codec: Codec,
    cast: String,
}

struct ExpressionIndex {
    expression: String,
    cast: String,
}

struct Relation {
    kind: String,
    readable: bool,
    columns: Vec<Column>,
    indexes: HashMap<String, ExpressionIndex>,
}

struct Statement {
    sql: String,
    params: Vec<String>,
    columns: Vec<String>,
    codecs: Vec<Codec>,
    limit: u32,
}

struct Active {
    generation: u32,
    cancel: watch::Sender<bool>,
    requests: usize,
}

struct Registration<'a> {
    searcher: &'a Searcher,
    palette: Uuid,
    generation: u32,
    cancel: watch::Receiver<bool>,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        let mut active = self
            .searcher
            .active
            .lock()
            .expect("search registry poisoned");
        if let Some(entry) = active.get_mut(&self.palette)
            && entry.generation == self.generation
        {
            entry.requests -= 1;
            if entry.requests == 0 {
                active.remove(&self.palette);
            }
        }
    }
}

pub struct Searcher {
    pool: Pool,
    tls: MakeRustlsConnect,
    active: Mutex<HashMap<Uuid, Active>>,
}

impl Searcher {
    pub fn new(pool: Pool, tls: MakeRustlsConnect) -> Self {
        Self {
            pool,
            tls,
            active: Mutex::new(HashMap::new()),
        }
    }

    pub fn warm(&self) {
        let pool = self.pool.clone();
        tokio::spawn(async move {
            let _ = join_all((0..PARALLELISM).map(|_| pool.get())).await;
        });
    }

    fn register(&self, palette: Uuid, generation: u32) -> Option<Registration<'_>> {
        let mut active = self.active.lock().expect("search registry poisoned");
        let cancel = match active.get_mut(&palette) {
            Some(entry) if entry.generation > generation => return None,
            Some(entry) if entry.generation == generation => {
                entry.requests += 1;
                entry.cancel.subscribe()
            }
            _ => {
                let (sender, receiver) = watch::channel(false);
                let entry = Active {
                    generation,
                    cancel: sender,
                    requests: 1,
                };
                if let Some(previous) = active.insert(palette, entry) {
                    previous.cancel.send_replace(true);
                }
                receiver
            }
        };
        Some(Registration {
            searcher: self,
            palette,
            generation,
            cancel,
        })
    }

    pub async fn search(
        &self,
        palette: Uuid,
        generation: u32,
        fingerprint: bool,
        probes: &[Probe],
    ) -> Result<SearchResults, Error> {
        let Some(registration) = self.register(palette, generation) else {
            return Ok(SearchResults::cancelled(probes.len()));
        };
        if probes.is_empty() && !fingerprint {
            return Ok(SearchResults::cancelled(0));
        }
        let mut cancel = registration.cancel.clone();
        let prepared = tokio::select! {
            prepared = self.prepare(probes, fingerprint) => prepared?,
            () = cancelled(&mut cancel) => return Ok(SearchResults::cancelled(probes.len())),
        };
        let (fingerprint, planned) = prepared;
        let mut results = Vec::with_capacity(planned.len());
        let mut statements = Vec::new();
        for (index, planned) in planned.into_iter().enumerate() {
            match planned {
                Ok(statement) => {
                    results.push(ProbeResult::Cancelled);
                    statements.push((index, statement));
                }
                Err(result) => results.push(result),
            }
        }
        let workers = statements.len().min(PARALLELISM);
        let mut chunks = (0..workers).map(|_| Vec::new()).collect::<Vec<_>>();
        for (position, statement) in statements.into_iter().enumerate() {
            chunks[position % workers].push(statement);
        }
        let finished = join_all(
            chunks
                .into_iter()
                .map(|chunk| self.run(chunk, registration.cancel.clone())),
        )
        .await;
        for (index, result) in finished.into_iter().flatten() {
            results[index] = result;
        }
        drop(registration);
        Ok(SearchResults {
            fingerprint,
            results,
        })
    }

    async fn prepare(
        &self,
        probes: &[Probe],
        fingerprint: bool,
    ) -> Result<(Option<String>, Vec<Result<Statement, ProbeResult>>), Error> {
        let client = self.pool.get().await?;
        let schemas = probes
            .iter()
            .map(|probe| probe.schema.as_str())
            .collect::<Vec<_>>();
        let tables = probes
            .iter()
            .map(|probe| probe.table.as_str())
            .collect::<Vec<_>>();
        let params: [(&(dyn ToSql + Sync), Type); 2] =
            [(&schemas, Type::TEXT_ARRAY), (&tables, Type::TEXT_ARRAY)];
        let catalog = client.query_typed(CATALOG, &params);
        let fingerprint = async {
            if !fingerprint {
                return Ok(None);
            }
            let row = client.query_typed_one(FINGERPRINT, &[]).await?;
            Ok::<_, tokio_postgres::Error>(Some(row.get::<_, String>("fingerprint")))
        };
        let (catalog, fingerprint) = tokio::try_join!(catalog, fingerprint)?;
        let trigram_schema = catalog
            .first()
            .and_then(|row| row.get::<_, Option<String>>("trigram_schema"));
        let relations = catalog
            .iter()
            .map(|row| {
                let key = (row.get::<_, String>("schema"), row.get::<_, String>("name"));
                (key, Relation::from(row))
            })
            .collect::<HashMap<_, _>>();
        let planned = probes
            .iter()
            .map(|probe| {
                let key = (probe.schema.clone(), probe.table.clone());
                let relation = relations.get(&key).ok_or_else(|| ProbeResult::Failed {
                    message: format!(
                        "relation {}.{} does not exist",
                        quote_identifier(&probe.schema),
                        quote_identifier(&probe.table)
                    ),
                })?;
                if !relation.readable {
                    return Err(ProbeResult::Denied);
                }
                statement(probe, relation, trigram_schema.as_deref())
                    .map_err(|message| ProbeResult::Failed { message })
            })
            .collect();
        Ok((fingerprint, planned))
    }

    async fn run(
        &self,
        chunk: Vec<(usize, Statement)>,
        mut cancel: watch::Receiver<bool>,
    ) -> Vec<(usize, ProbeResult)> {
        let client = tokio::select! {
            client = self.pool.get() => client,
            () = cancelled(&mut cancel) => return cancel_all(&chunk),
        };
        let client = match client {
            Ok(client) => client,
            Err(error) => {
                let message = Error::from(error).describe();
                return chunk
                    .iter()
                    .map(|(index, _)| {
                        let message = message.clone();
                        (*index, ProbeResult::Failed { message })
                    })
                    .collect();
            }
        };
        let token = client.cancel_token();
        let outcome = tokio::select! {
            results = join_all(chunk.iter().map(|(_, statement)| execute(&client, statement))) => Some(results),
            () = cancelled(&mut cancel) => None,
        };
        let Some(results) = outcome else {
            let _ = token.cancel_query(self.tls.clone()).await;
            drop(Object::take(client));
            return cancel_all(&chunk);
        };
        chunk
            .iter()
            .zip(results)
            .map(|((index, statement), result)| (*index, statement.result(result)))
            .collect()
    }
}

impl SearchResults {
    fn cancelled(count: usize) -> Self {
        Self {
            fingerprint: None,
            results: (0..count).map(|_| ProbeResult::Cancelled).collect(),
        }
    }
}

fn cancel_all(chunk: &[(usize, Statement)]) -> Vec<(usize, ProbeResult)> {
    chunk
        .iter()
        .map(|(index, _)| (*index, ProbeResult::Cancelled))
        .collect()
}

async fn cancelled(receiver: &mut watch::Receiver<bool>) {
    if receiver.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

async fn execute(
    client: &Object,
    statement: &Statement,
) -> Result<Vec<tokio_postgres::Row>, tokio_postgres::Error> {
    let params = statement
        .params
        .iter()
        .map(|param| (param as &(dyn ToSql + Sync), Type::TEXT))
        .collect::<Vec<_>>();
    client.query_typed(&statement.sql, &params).await
}

impl Statement {
    fn result(
        &self,
        result: Result<Vec<tokio_postgres::Row>, tokio_postgres::Error>,
    ) -> ProbeResult {
        let rows = match result {
            Ok(rows) => rows,
            Err(error) => {
                return match error.code() {
                    Some(&SqlState::QUERY_CANCELED | &SqlState::LOCK_NOT_AVAILABLE) => {
                        ProbeResult::TimedOut
                    }
                    Some(&SqlState::INSUFFICIENT_PRIVILEGE) => ProbeResult::Denied,
                    _ => ProbeResult::Failed {
                        message: Error::from(error).describe(),
                    },
                };
            }
        };
        let hits = rows
            .iter()
            .map(|row| {
                let mut values = row.get::<_, Vec<Option<String>>>("values");
                let matched = values
                    .split_off(self.codecs.len())
                    .into_iter()
                    .map(|value| value.as_deref() == Some("true"))
                    .collect();
                let cells = values
                    .into_iter()
                    .zip(&self.codecs)
                    .map(|(value, codec)| value.map(|value| codec.decode(value)))
                    .collect();
                Hit { cells, matched }
            })
            .collect();
        ProbeResult::Rows {
            columns: self.columns.clone(),
            hits,
            limit: self.limit,
        }
    }
}

impl From<&tokio_postgres::Row> for Relation {
    fn from(row: &tokio_postgres::Row) -> Self {
        let names = row.get::<_, Vec<String>>("column_names");
        let types = row.get::<_, Vec<u32>>("column_types");
        let type_names = row.get::<_, Vec<String>>("column_type_names");
        let columns = names
            .into_iter()
            .zip(types)
            .zip(type_names)
            .map(|((name, oid), type_name)| Column {
                name,
                codec: Codec::for_type(oid),
                cast: cast_for(oid, type_name),
            })
            .collect();
        let indexes = row
            .get::<_, Vec<String>>("index_names")
            .into_iter()
            .zip(row.get::<_, Vec<String>>("index_expressions"))
            .zip(row.get::<_, Vec<String>>("index_types"))
            .map(|((name, expression), cast)| (name, ExpressionIndex { expression, cast }))
            .collect();
        Self {
            kind: row.get("kind"),
            readable: row.get("readable"),
            columns,
            indexes,
        }
    }
}

fn cast_for(oid: u32, type_name: String) -> String {
    if oid == Type::BPCHAR.oid() {
        "bpchar".into()
    } else {
        type_name
    }
}

fn escape_like(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| match character {
            '\\' | '%' | '_' => vec!['\\', character],
            _ => vec![character],
        })
        .collect()
}

fn statement(
    probe: &Probe,
    relation: &Relation,
    trigram_schema: Option<&str>,
) -> Result<Statement, String> {
    if probe.conditions.is_empty() {
        return Err("no conditions to search".into());
    }
    let column = |name: &str| {
        relation
            .columns
            .iter()
            .find(|column| column.name == name)
            .ok_or_else(|| format!("column {} does not exist", quote_identifier(name)))
    };
    let mut params = Vec::new();
    let mut param = |value: String| {
        params.push(value);
        format!("${}", params.len())
    };
    let conditions = probe
        .conditions
        .iter()
        .map(|condition| {
            Ok(match condition {
                Condition::Equal { column: name, value } => {
                    let column = column(name)?;
                    format!(
                        "source.{} = {}::text::{}",
                        quote_identifier(name),
                        param(value.clone()),
                        column.cast
                    )
                }
                Condition::Range {
                    column: name,
                    from,
                    to,
                } => {
                    let column = column(name)?;
                    let name = quote_identifier(name);
                    format!(
                        "(source.{name} >= {}::text::{cast} AND source.{name} < {}::text::{cast})",
                        param(from.clone()),
                        param(to.clone()),
                        cast = column.cast
                    )
                }
                Condition::Insensitive { column: name, value } => {
                    column(name)?;
                    format!(
                        "lower(source.{}::text) = lower({}::text)",
                        quote_identifier(name),
                        param(value.clone())
                    )
                }
                Condition::Index { index, value } => {
                    let index = relation
                        .indexes
                        .get(index)
                        .ok_or_else(|| format!("index {} does not exist", quote_identifier(index)))?;
                    format!(
                        "({}) = {}::text::{}",
                        index.expression,
                        param(value.clone()),
                        index.cast
                    )
                }
                Condition::Trigram { column: name, value } => {
                    column(name)?;
                    let name = quote_identifier(name);
                    let pattern = param(format!("%{}%", escape_like(value)));
                    match trigram_schema {
                        Some(schema) => format!(
                            "(source.{name} ILIKE {pattern} OR source.{name} OPERATOR({schema}.%) {}::text)",
                            param(value.clone())
                        ),
                        None => format!("source.{name} ILIKE {pattern}"),
                    }
                }
                Condition::Json {
                    column: name,
                    value,
                    number,
                } => {
                    column(name)?;
                    let literal = if *number {
                        format!("({}::text::numeric)::text", param(value.clone()))
                    } else {
                        format!("to_json({}::text)::text", param(value.clone()))
                    };
                    format!(
                        "source.{} @? ('$.** ? (@ == ' || {literal} || ')')::jsonpath",
                        quote_identifier(name)
                    )
                }
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let projection = relation
        .columns
        .iter()
        .map(|column| column.codec.select(&column.name))
        .chain(
            conditions
                .iter()
                .enumerate()
                .map(|(index, condition)| format!("({condition}) AS matched_{index}")),
        )
        .collect::<Vec<_>>()
        .join(", ");
    let only = if relation.kind == "r" { "ONLY " } else { "" };
    let limit =
        (ROWS_PER_CONDITION * u32::try_from(conditions.len()).unwrap_or(u32::MAX)).min(MAX_ROWS);
    let sql = format!(
        "SELECT array(
            SELECT value FROM json_each_text(row_to_json(t)) WITH ORDINALITY e(key, value, n)
            ORDER BY n
        ) AS values
        FROM (
            SELECT {projection} FROM {only}{}.{} source WHERE {} LIMIT {limit}
        ) t",
        quote_identifier(&probe.schema),
        quote_identifier(&probe.table),
        conditions
            .iter()
            .map(|condition| format!("({condition})"))
            .collect::<Vec<_>>()
            .join(" OR ")
    );
    Ok(Statement {
        sql,
        params,
        columns: relation
            .columns
            .iter()
            .map(|column| column.name.clone())
            .collect(),
        codecs: relation.columns.iter().map(|column| column.codec).collect(),
        limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn relation() -> Relation {
        Relation {
            kind: "r".into(),
            readable: true,
            columns: vec![
                Column {
                    name: "id".into(),
                    codec: Codec::Text,
                    cast: "bigint".into(),
                },
                Column {
                    name: "Email".into(),
                    codec: Codec::Text,
                    cast: "text".into(),
                },
                Column {
                    name: "avatar".into(),
                    codec: Codec::Binary,
                    cast: "bytea".into(),
                },
            ],
            indexes: HashMap::from([(
                "users_lower_idx".into(),
                ExpressionIndex {
                    expression: "lower(\"Email\")".into(),
                    cast: "text".into(),
                },
            )]),
        }
    }

    fn probe(conditions: Vec<Condition>) -> Probe {
        Probe {
            schema: "public".into(),
            table: "Users".into(),
            conditions,
        }
    }

    #[test]
    fn binds_values_as_the_column_type() {
        let statement = statement(
            &probe(vec![Condition::Equal {
                column: "id".into(),
                value: "42".into(),
            }]),
            &relation(),
            None,
        )
        .unwrap();
        assert!(statement.sql.contains("source.\"id\" = $1::text::bigint"));
        assert!(
            statement
                .sql
                .contains("FROM ONLY \"public\".\"Users\" source")
        );
        assert!(
            statement
                .sql
                .contains("octet_length(\"avatar\") AS \"avatar\"")
        );
        assert!(statement.sql.contains("LIMIT 6"));
        assert_eq!(statement.params, vec!["42"]);
        assert_eq!(statement.columns, vec!["id", "Email", "avatar"]);
    }

    #[test]
    fn ors_conditions_and_reports_which_matched() {
        let statement = statement(
            &probe(vec![
                Condition::Index {
                    index: "users_lower_idx".into(),
                    value: "ada@example.com".into(),
                },
                Condition::Equal {
                    column: "Email".into(),
                    value: "Ada@example.com".into(),
                },
            ]),
            &relation(),
            None,
        )
        .unwrap();
        assert!(statement.sql.contains(
            "WHERE ((lower(\"Email\")) = $1::text::text) OR (source.\"Email\" = $2::text::text)"
        ));
        assert!(
            statement
                .sql
                .contains("((lower(\"Email\")) = $1::text::text) AS matched_0")
        );
        assert!(statement.sql.contains("LIMIT 12"));
    }

    #[test]
    fn escapes_trigram_patterns() {
        let statement = statement(
            &probe(vec![Condition::Trigram {
                column: "Email".into(),
                value: "50%_off\\".into(),
            }]),
            &relation(),
            Some("public"),
        )
        .unwrap();
        assert_eq!(statement.params, vec!["%50\\%\\_off\\\\%", "50%_off\\"]);
        assert!(statement.sql.contains("OPERATOR(public.%) $2::text"));
    }

    #[test]
    fn queries_partitioned_tables_through_the_parent() {
        let mut relation = relation();
        relation.kind = "p".into();
        let statement = statement(
            &probe(vec![Condition::Range {
                column: "id".into(),
                from: "1".into(),
                to: "2".into(),
            }]),
            &relation,
            None,
        )
        .unwrap();
        assert!(statement.sql.contains("FROM \"public\".\"Users\" source"));
        assert!(
            statement.sql.contains(
                "(source.\"id\" >= $1::text::bigint AND source.\"id\" < $2::text::bigint)"
            )
        );
    }

    #[test]
    fn rejects_unknown_columns_and_indexes() {
        for condition in [
            Condition::Equal {
                column: "missing".into(),
                value: "1".into(),
            },
            Condition::Index {
                index: "missing".into(),
                value: "1".into(),
            },
        ] {
            assert!(statement(&probe(vec![condition]), &relation(), None).is_err());
        }
    }

    #[test]
    fn caps_rows_per_statement() {
        let conditions = (0..20)
            .map(|_| Condition::Equal {
                column: "id".into(),
                value: "1".into(),
            })
            .collect();
        let statement = statement(&probe(conditions), &relation(), None).unwrap();
        assert_eq!(statement.limit, MAX_ROWS);
    }
}
