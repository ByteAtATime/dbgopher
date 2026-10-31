use std::error::Error;
use std::process::ExitCode;
use std::sync::Arc;

use connector::config::Config;
use connector::database::Database;
use connector::{connection, error_chain};

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => return fail(&error),
    };
    let database = match Database::new(config.database.clone()) {
        Ok(database) => Arc::new(database),
        Err(error) => return fail(&error),
    };
    let close = connection::run(&config, database).await;
    eprintln!(
        "Relay closed the connection ({}): {}",
        close.reason().as_str_name(),
        close.detail
    );
    ExitCode::FAILURE
}

fn fail(error: &dyn Error) -> ExitCode {
    eprintln!("{}", error_chain(error));
    ExitCode::FAILURE
}
