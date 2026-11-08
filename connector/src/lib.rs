pub mod browse;
pub mod codec;
pub mod config;
pub mod connection;
pub mod database;
pub mod envelope;
pub mod messages;
pub mod overview;
pub mod pairing;
pub mod palette;
pub mod state;

pub mod relay {
    include!(concat!(env!("OUT_DIR"), "/dbgopher.relay.rs"));
}

pub const RELAY_PROTOCOL_VERSION: u32 = 2;

pub fn error_chain(error: &dyn std::error::Error) -> String {
    std::iter::successors(Some(error), |error| error.source())
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(": ")
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    hex::decode(hex.trim()).ok()?.try_into().ok()
}
