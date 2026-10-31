pub mod config;
pub mod connection;
pub mod envelope;
pub mod messages;

pub mod relay {
    include!(concat!(env!("OUT_DIR"), "/dbgopher.relay.rs"));
}

pub const RELAY_PROTOCOL_VERSION: u32 = 1;
