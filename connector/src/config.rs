use std::env;

pub struct Config {
    pub relay_url: String,
    pub connector_id: String,
    pub token: String,
    pub connector_key: [u8; 32],
    pub database: tokio_postgres::Config,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("CONNECTOR_KEY must be 64 hex characters")]
    InvalidKey,
    #[error("DATABASE_URL is invalid")]
    InvalidDatabaseUrl(#[source] tokio_postgres::Error),
}

impl Config {
    pub fn from_env() -> Result<Self, Error> {
        let connector_key = hex::decode(var("CONNECTOR_KEY")?)
            .ok()
            .and_then(|key| key.try_into().ok())
            .ok_or(Error::InvalidKey)?;
        Ok(Self {
            relay_url: var("RELAY_URL")?,
            connector_id: var("CONNECTOR_ID")?,
            token: var("CONNECTOR_TOKEN")?,
            connector_key,
            database: var("DATABASE_URL")?
                .parse()
                .map_err(Error::InvalidDatabaseUrl)?,
        })
    }
}

fn var(name: &'static str) -> Result<String, Error> {
    env::var(name).map_err(|_| Error::Missing(name))
}
