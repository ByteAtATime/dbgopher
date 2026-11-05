use std::borrow::Cow;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

mod cipher;
mod session;
#[cfg(test)]
mod vectors;

pub use session::{Channels, Responder};

#[derive(Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Envelope<T> {
    pub id: Uuid,
    #[ts(type = "number")]
    pub sent_at: u64,
    pub body: T,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("unsupported frame kind {0}")]
    UnsupportedFrame(u8),
    #[error("message could not be decrypted")]
    Undecryptable,
    #[error("message is malformed")]
    Malformed,
    #[error("message is too old or too far in the future")]
    Expired,
    #[error("message was already received")]
    Replayed,
    #[error("request was sealed for a prekey the connector no longer holds")]
    StaleKey,
    #[error(transparent)]
    Compression(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
enum Encoding {
    Json = 0,
    Zstd = 1,
}

impl Encoding {
    const COMPRESSION_THRESHOLD: usize = 4096;
    const ZSTD_LEVEL: i32 = 3;
}

impl TryFrom<u8> for Encoding {
    type Error = Error;

    fn try_from(byte: u8) -> Result<Self, Error> {
        match byte {
            0 => Ok(Self::Json),
            1 => Ok(Self::Zstd),
            _ => Err(Error::Malformed),
        }
    }
}

impl<T: Serialize> Envelope<T> {
    fn encode(&self) -> Result<Vec<u8>, Error> {
        let json = serde_json::to_vec(self)?;
        if json.len() <= Encoding::COMPRESSION_THRESHOLD {
            return Ok([&[Encoding::Json as u8], json.as_slice()].concat());
        }
        let mut encoded = vec![Encoding::Zstd as u8];
        zstd::stream::copy_encode(json.as_slice(), &mut encoded, Encoding::ZSTD_LEVEL)?;
        Ok(encoded)
    }
}

impl<T: DeserializeOwned> Envelope<T> {
    fn decode(plaintext: &[u8]) -> Result<Self, Error> {
        let (&encoding, payload) = plaintext.split_first().ok_or(Error::Malformed)?;
        let json = match Encoding::try_from(encoding)? {
            Encoding::Json => Cow::Borrowed(payload),
            Encoding::Zstd => Cow::Owned(zstd::decode_all(payload)?),
        };
        Ok(serde_json::from_slice(&json)?)
    }
}

fn now_ms() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is after the Unix epoch");
    u64::try_from(elapsed.as_millis()).expect("milliseconds since the Unix epoch fit in a u64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn decodes_vector_messages() {
        for message in vectors::load().messages {
            let plaintext = hex::decode(&message.plaintext).unwrap();
            assert_eq!(
                Envelope::<Value>::decode(&plaintext).unwrap(),
                message.envelope
            );
        }
    }

    #[test]
    fn compresses_large_envelopes() {
        for (body, encoding) in [
            (json!("small"), Encoding::Json),
            (
                json!("x".repeat(Encoding::COMPRESSION_THRESHOLD)),
                Encoding::Zstd,
            ),
        ] {
            let envelope = Envelope {
                id: Uuid::new_v4(),
                sent_at: 1_000_000,
                body,
            };
            let encoded = envelope.encode().unwrap();
            assert_eq!(Encoding::try_from(encoded[0]).unwrap(), encoding);
            assert_eq!(Envelope::<Value>::decode(&encoded).unwrap(), envelope);
        }
    }
}
