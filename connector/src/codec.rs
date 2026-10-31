use serde::Serialize;
use tokio_postgres::types::Type;
use ts_rs::TS;

use crate::overview::quote_identifier;

#[derive(Debug, Serialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum Cell {
    Text(String),
    Binary { bytes: u32 },
}

#[derive(Debug, Clone, Copy)]
pub enum Codec {
    Text,
    Binary,
}

impl Codec {
    pub fn for_type(oid: u32) -> Self {
        if oid == Type::BYTEA.oid() {
            Self::Binary
        } else {
            Self::Text
        }
    }

    pub fn select(self, column: &str) -> String {
        let column = quote_identifier(column);
        match self {
            Self::Text => column,
            Self::Binary => format!("octet_length({column}) AS {column}"),
        }
    }

    pub fn decode(self, value: String) -> Cell {
        match self {
            Self::Text => Cell::Text(value),
            Self::Binary => Cell::Binary {
                bytes: value.parse().expect("octet_length returns an int4"),
            },
        }
    }
}
