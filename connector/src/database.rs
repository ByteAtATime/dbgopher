use std::ops::Deref;
use std::time::Duration;

use deadpool_postgres::{BuildError, Manager, ManagerConfig, Object, Pool, PoolError, Runtime};
use futures_util::future::try_join;
use tokio_postgres::{Client, Transaction};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error_chain;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("could not get a database connection")]
    Pool(#[source] PoolError),
    #[error(transparent)]
    Postgres(#[from] tokio_postgres::Error),
}

impl From<PoolError> for Error {
    fn from(error: PoolError) -> Self {
        match error {
            PoolError::Backend(error) => Self::Postgres(error),
            error => Self::Pool(error),
        }
    }
}

impl Error {
    pub fn describe(&self) -> String {
        if let Self::Postgres(error) = self
            && let Some(error) = error.as_db_error()
        {
            return error.to_string();
        }
        error_chain(self)
    }
}

pub struct Database(Pool);

impl Database {
    const MAX_CONNECTIONS: usize = 4;
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const WAIT_TIMEOUT: Duration = Duration::from_secs(25);
    const SET_STATEMENT_TIMEOUT: &str = "SET LOCAL statement_timeout = '25s'";
    const BEGIN_PIPELINED: &str =
        "BEGIN READ ONLY; SET LOCAL idle_in_transaction_session_timeout = '5s';";

    pub fn new(mut config: tokio_postgres::Config) -> Result<Self, BuildError> {
        if config.get_connect_timeout().is_none() {
            config.connect_timeout(Self::CONNECT_TIMEOUT);
        }
        let manager = Manager::from_config(
            config,
            MakeRustlsConnect::with_webpki_roots(),
            ManagerConfig::default(),
        );
        let pool = Pool::builder(manager)
            .max_size(Self::MAX_CONNECTIONS)
            .wait_timeout(Some(Self::WAIT_TIMEOUT))
            .runtime(Runtime::Tokio1)
            .build()?;
        Ok(Self(pool))
    }

    pub async fn read<T>(
        &self,
        query: impl AsyncFnOnce(&Transaction<'_>) -> Result<T, tokio_postgres::Error>,
    ) -> Result<T, Error> {
        let mut client = self.0.get().await?;
        let transaction = client.build_transaction().read_only(true).start().await?;
        transaction
            .batch_execute(Self::SET_STATEMENT_TIMEOUT)
            .await?;
        let result = query(&transaction).await?;
        transaction.commit().await?;
        Ok(result)
    }

    pub async fn read_pipelined<T>(
        &self,
        settings: &str,
        query: impl AsyncFnOnce(&Client) -> Result<T, tokio_postgres::Error>,
    ) -> Result<T, Error> {
        let client = Lease(Some(self.0.get().await?));
        let begin = format!("{} {settings}", Self::BEGIN_PIPELINED);
        let result = try_join(client.batch_execute(&begin), query(&client))
            .await
            .map(|((), value)| value);
        if result.is_ok() || client.batch_execute("ROLLBACK").await.is_ok() {
            client.release();
        }
        Ok(result?)
    }
}

struct Lease(Option<Object>);

impl Lease {
    fn release(mut self) {
        drop(self.0.take());
    }
}

impl Deref for Lease {
    type Target = Client;

    fn deref(&self) -> &Client {
        self.0
            .as_ref()
            .expect("a lease holds its client until released")
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(object) = self.0.take() {
            drop(Object::take(object));
        }
    }
}
