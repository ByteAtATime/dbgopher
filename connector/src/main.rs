use std::process::ExitCode;

use connector::config::Config;
use connector::connection;

#[tokio::main]
async fn main() -> ExitCode {
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    let close = connection::run(&config).await;
    eprintln!(
        "Relay closed the connection ({}): {}",
        close.reason().as_str_name(),
        close.detail
    );
    ExitCode::FAILURE
}
