use std::env;
use std::path::PathBuf;

use ed25519_dalek::VerifyingKey;
use uuid::Uuid;

use crate::decode_key;
use crate::pairing::{InvalidPairingCode, PairingCode};

pub struct Config {
    pub relay_url: String,
    pub connector_id: Uuid,
    pub state_dir: PathBuf,
    pub pairing_code: Option<PairingCode>,
    pub user_key: Option<VerifyingKey>,
    pub database: tokio_postgres::Config,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("CONNECTOR_ID must be a UUID")]
    InvalidConnectorId,
    #[error(transparent)]
    InvalidPairingCode(#[from] InvalidPairingCode),
    #[error("USER_KEY must be an Ed25519 public key in 64 hex characters")]
    InvalidUserKey,
    #[error("DATABASE_URL is invalid")]
    InvalidDatabaseUrl(#[source] tokio_postgres::Error),
}

impl Config {
    pub fn from_env() -> Result<Self, Error> {
        Ok(Self {
            relay_url: var("RELAY_URL")?,
            connector_id: var("CONNECTOR_ID")?
                .parse()
                .map_err(|_| Error::InvalidConnectorId)?,
            state_dir: var("CONNECTOR_STATE_DIR")?.into(),
            pairing_code: optional("PAIRING_CODE")
                .map(|code| code.parse())
                .transpose()?,
            user_key: optional("USER_KEY").map(parse_user_key).transpose()?,
            database: var("DATABASE_URL")?
                .parse()
                .map_err(Error::InvalidDatabaseUrl)?,
        })
    }
}

fn parse_user_key(hex: String) -> Result<VerifyingKey, Error> {
    decode_key(&hex)
        .and_then(|key| VerifyingKey::from_bytes(&key).ok())
        .ok_or(Error::InvalidUserKey)
}

fn var(name: &'static str) -> Result<String, Error> {
    optional(name).ok_or(Error::Missing(name))
}

fn optional(name: &'static str) -> Option<String> {
    env::var(name).ok().filter(|value| !value.is_empty())
}
