use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use connector::config::{self, Config};
use connector::database::Database;
use connector::relay::Close;
use connector::state::{self, State};
use connector::{connection, error_chain};

#[derive(Debug, thiserror::Error)]
enum Error {
    #[error(transparent)]
    Config(#[from] config::Error),
    #[error(transparent)]
    State(#[from] state::Error),
    #[error("PAIRING_CODE is not set and this connector has not been paired")]
    Unpaired,
    #[error("could not pair with the relay")]
    Pairing(#[source] connection::Error),
    #[error("{} lists no user keys; set USER_KEY", .0.display())]
    NoUsers(PathBuf),
    #[error("could not set up the database pool")]
    Database(#[from] deadpool_postgres::BuildError),
}

#[tokio::main]
async fn main() -> ExitCode {
    match start().await {
        Ok(close) => eprintln!(
            "Relay closed the connection ({}): {}",
            close.reason().as_str_name(),
            close.detail
        ),
        Err(error) => eprintln!("{}", error_chain(&error)),
    }
    ExitCode::FAILURE
}

async fn start() -> Result<Close, Error> {
    let config = Config::from_env()?;
    let mut state = State::open(config.state_dir.clone())?;
    if let Some(user) = config.user_key {
        state.allow(user)?;
    }
    if state.users.is_empty() {
        return Err(Error::NoUsers(state.allowlist_path()));
    }
    let token = match state.token.clone() {
        Some(token) => token,
        None => {
            let code = config.pairing_code.as_ref().ok_or(Error::Unpaired)?;
            let token = connection::enroll(&config, &state.identity, code)
                .await
                .map_err(Error::Pairing)?;
            state.save_token(token.clone())?;
            eprintln!("Paired with relay");
            token
        }
    };
    let database = Arc::new(Database::new(config.database.clone())?);
    Ok(connection::run(&config, &state, &token, database).await)
}
