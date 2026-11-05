use std::time::Duration;

use deadpool_postgres::{
    BuildError, Hook, HookError, Manager, ManagerConfig, Pool, PoolError, Runtime,
};
use tokio_postgres::Transaction;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::error_chain;
use crate::search::{self, Searcher};

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

pub struct Database {
    pool: Pool,
    searcher: Searcher,
}

impl Database {
    const MAX_CONNECTIONS: usize = 4;
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
    const WAIT_TIMEOUT: Duration = Duration::from_secs(25);
    const SEARCH_WAIT_TIMEOUT: Duration = Duration::from_secs(5);
    const SET_STATEMENT_TIMEOUT: &str = "SET LOCAL statement_timeout = '25s'";

    pub fn new(mut config: tokio_postgres::Config) -> Result<Self, BuildError> {
        if config.get_connect_timeout().is_none() {
            config.connect_timeout(Self::CONNECT_TIMEOUT);
        }
        let tls = MakeRustlsConnect::with_webpki_roots();
        let manager = Manager::from_config(config.clone(), tls.clone(), ManagerConfig::default());
        let pool = Pool::builder(manager)
            .max_size(Self::MAX_CONNECTIONS)
            .wait_timeout(Some(Self::WAIT_TIMEOUT))
            .runtime(Runtime::Tokio1)
            .build()?;
        let search_manager = Manager::from_config(config, tls.clone(), ManagerConfig::default());
        let search_pool = Pool::builder(search_manager)
            .max_size(search::PARALLELISM)
            .wait_timeout(Some(Self::SEARCH_WAIT_TIMEOUT))
            .runtime(Runtime::Tokio1)
            .post_create(Hook::async_fn(|client, _| {
                Box::pin(async move {
                    client
                        .batch_execute(search::SESSION)
                        .await
                        .map_err(HookError::Backend)?;
                    let _ = client.batch_execute(search::CLIENT_CHECK).await;
                    Ok(())
                })
            }))
            .build()?;
        Ok(Self {
            pool,
            searcher: Searcher::new(search_pool, tls),
        })
    }

    pub fn searcher(&self) -> &Searcher {
        &self.searcher
    }

    pub async fn read<T>(
        &self,
        query: impl AsyncFnOnce(&Transaction<'_>) -> Result<T, tokio_postgres::Error>,
    ) -> Result<T, Error> {
        let mut client = self.pool.get().await?;
        let transaction = client.build_transaction().read_only(true).start().await?;
        transaction
            .batch_execute(Self::SET_STATEMENT_TIMEOUT)
            .await?;
        let result = query(&transaction).await?;
        transaction.commit().await?;
        Ok(result)
    }
}
