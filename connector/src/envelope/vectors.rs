use serde::Deserialize;
use serde_json::Value;

use super::Envelope;
use super::cipher::Direction;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vectors {
    pub connector_key: String,
    pub connector_id: String,
    pub handshake: Handshake,
    pub request_key: String,
    pub response_key: String,
    pub messages: Vec<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Handshake {
    pub session_id: String,
    pub browser_secret: String,
    pub browser_public: String,
    pub connector_secret: String,
    pub connector_public: String,
    pub shared: String,
    pub session_key: String,
    pub frame: String,
}

#[derive(Deserialize)]
pub struct Message {
    pub direction: Direction,
    pub envelope: Envelope<Value>,
    pub nonce: String,
    pub plaintext: String,
    pub sealed: String,
}

pub fn load() -> Vectors {
    serde_json::from_str(include_str!("../../../protocol/vectors.json")).unwrap()
}

pub fn bytes(hex: &str) -> [u8; 32] {
    hex::decode(hex).unwrap().try_into().unwrap()
}
