pub mod config;
pub mod connection;
pub mod database;
pub mod envelope;
pub mod messages;
pub mod overview;

pub mod relay {
    include!(concat!(env!("OUT_DIR"), "/dbgopher.relay.rs"));
}

pub const RELAY_PROTOCOL_VERSION: u32 = 1;

pub fn error_chain(error: &dyn std::error::Error) -> String {
    std::iter::successors(Some(error), |error| error.source())
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(": ")
}
