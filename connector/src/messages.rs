use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::browse::{self, Rows, Sort};
use crate::database::Database;
use crate::overview::{self, Overview};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Request {
    Hello,
    Overview,
    Browse {
        schema: String,
        table: String,
        #[serde(default)]
        #[ts(optional)]
        limit: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        offset: Option<u32>,
        #[serde(default)]
        #[ts(optional)]
        sort: Option<Sort>,
    },
}

#[derive(Debug, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum Response {
    Hello {
        protocol_version: u32,
        connector_version: String,
        capabilities: Vec<Capability>,
        read_only: bool,
    },
    Overview(Overview),
    Browse(Rows),
    Error {
        message: String,
    },
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Capability {
    Overview,
    Browse,
}

pub async fn handle(database: &Database, request: Request) -> Response {
    match request {
        Request::Hello => Response::Hello {
            protocol_version: PROTOCOL_VERSION,
            connector_version: env!("CARGO_PKG_VERSION").into(),
            capabilities: vec![Capability::Overview, Capability::Browse],
            read_only: true,
        },
        Request::Overview => match database.read(overview::load).await {
            Ok(overview) => Response::Overview(overview),
            Err(error) => Response::Error {
                message: error.describe(),
            },
        },
        Request::Browse {
            schema,
            table,
            limit,
            offset,
            sort,
        } => {
            let limit = limit.unwrap_or(browse::DEFAULT_LIMIT);
            let offset = offset.unwrap_or(0);
            match database
                .read(async |transaction| {
                    browse::load(transaction, &schema, &table, limit, offset, sort.as_ref()).await
                })
                .await
            {
                Ok(rows) => Response::Browse(rows),
                Err(error) => Response::Error {
                    message: error.describe(),
                },
            }
        }
    }
}
