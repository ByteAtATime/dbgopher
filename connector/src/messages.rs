use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::database::Database;
use crate::overview::{self, Overview};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum Request {
    Hello,
    Overview,
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
    Error {
        message: String,
    },
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Capability {
    Overview,
}

pub async fn handle(database: &Database, request: Request) -> Response {
    match request {
        Request::Hello => Response::Hello {
            protocol_version: PROTOCOL_VERSION,
            connector_version: env!("CARGO_PKG_VERSION").into(),
            capabilities: vec![Capability::Overview],
            read_only: true,
        },
        Request::Overview => match database.read(overview::load).await {
            Ok(overview) => Response::Overview(overview),
            Err(error) => Response::Error {
                message: error.describe(),
            },
        },
    }
}
