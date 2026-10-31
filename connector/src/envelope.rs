use std::borrow::Cow;
use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use blake2::Blake2bMac;
use blake2::digest::{Mac, consts::U32};
use chacha20poly1305::aead::{Aead, Generate, Key, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

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
    #[error("unsupported envelope version {0}")]
    UnsupportedVersion(u8),
    #[error("message could not be decrypted")]
    Undecryptable,
    #[error("message is malformed")]
    Malformed,
    #[error("message is too old or too far in the future")]
    Expired,
    #[error("message was already received")]
    Replayed,
    #[error(transparent)]
    Compression(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

pub struct Channel {
    connector_id: String,
    request: Cipher,
    response: Cipher,
    seen: HashMap<Uuid, u64>,
}

impl Channel {
    const MAX_AGE_MS: u64 = 60_000;

    pub fn new(connector_key: &[u8; 32], connector_id: impl Into<String>) -> Self {
        Self {
            connector_id: connector_id.into(),
            request: Cipher::new(connector_key, Direction::Request),
            response: Cipher::new(connector_key, Direction::Response),
            seen: HashMap::new(),
        }
    }

    pub fn open_request<T: DeserializeOwned>(
        &mut self,
        sealed: &[u8],
    ) -> Result<Envelope<T>, Error> {
        self.open_request_at(sealed, now_ms())
    }

    pub fn seal_response<T: Serialize>(
        &self,
        request_id: Uuid,
        body: &T,
    ) -> Result<Vec<u8>, Error> {
        let envelope = Envelope {
            id: request_id,
            sent_at: now_ms(),
            body,
        };
        Ok(self
            .response
            .seal(self.aad(), &XNonce::generate(), &envelope.encode()?))
    }

    fn open_request_at<T: DeserializeOwned>(
        &mut self,
        sealed: &[u8],
        now: u64,
    ) -> Result<Envelope<T>, Error> {
        let envelope = Envelope::<T>::decode(&self.request.open(self.aad(), sealed)?)?;
        let is_fresh = |sent_at: u64| now.abs_diff(sent_at) <= Self::MAX_AGE_MS;
        if !is_fresh(envelope.sent_at) {
            return Err(Error::Expired);
        }
        self.seen.retain(|_, &mut sent_at| is_fresh(sent_at));
        if self.seen.insert(envelope.id, envelope.sent_at).is_some() {
            return Err(Error::Replayed);
        }
        Ok(envelope)
    }

    fn aad(&self) -> &[u8] {
        self.connector_id.as_bytes()
    }
}

#[derive(Clone, Copy)]
#[cfg_attr(test, derive(Deserialize), serde(rename_all = "lowercase"))]
enum Direction {
    Request,
    Response,
}

impl Direction {
    fn label(self) -> &'static [u8] {
        match self {
            Self::Request => b"dbgopher/request",
            Self::Response => b"dbgopher/response",
        }
    }

    fn derive_key(self, connector_key: &[u8; 32]) -> Key<XChaCha20Poly1305> {
        let mut mac = Blake2bMac::<U32>::new_from_slice(connector_key)
            .expect("32-byte keys are valid BLAKE2b keys");
        mac.update(self.label());
        mac.finalize().into_bytes()
    }
}

struct Cipher(XChaCha20Poly1305);

impl Cipher {
    const VERSION: u8 = 1;
    const NONCE_LEN: usize = 24;

    fn new(connector_key: &[u8; 32], direction: Direction) -> Self {
        Self(XChaCha20Poly1305::new(&direction.derive_key(connector_key)))
    }

    fn seal(&self, aad: &[u8], nonce: &XNonce, plaintext: &[u8]) -> Vec<u8> {
        let ciphertext = self
            .0
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .expect("plaintext fits in a single XChaCha20-Poly1305 message");
        [&[Self::VERSION], nonce.as_slice(), &ciphertext].concat()
    }

    fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, Error> {
        let (&version, rest) = sealed.split_first().ok_or(Error::Undecryptable)?;
        if version != Self::VERSION {
            return Err(Error::UnsupportedVersion(version));
        }
        let (nonce, ciphertext) = rest
            .split_first_chunk::<{ Self::NONCE_LEN }>()
            .ok_or(Error::Undecryptable)?;
        self.0
            .decrypt(
                &XNonce::from(*nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .map_err(|_| Error::Undecryptable)
    }
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

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Vectors {
        connector_key: String,
        connector_id: String,
        request_key: String,
        response_key: String,
        messages: Vec<Message>,
    }

    #[derive(Deserialize)]
    struct Message {
        direction: Direction,
        envelope: Envelope<Value>,
        nonce: String,
        plaintext: String,
        sealed: String,
    }

    fn vectors() -> Vectors {
        serde_json::from_str(include_str!("../../protocol/vectors.json")).unwrap()
    }

    fn connector_key(vectors: &Vectors) -> [u8; 32] {
        hex::decode(&vectors.connector_key)
            .unwrap()
            .try_into()
            .unwrap()
    }

    fn channel() -> Channel {
        let vectors = vectors();
        Channel::new(&connector_key(&vectors), vectors.connector_id)
    }

    fn seal_request(channel: &Channel, envelope: &Envelope<Value>) -> Vec<u8> {
        channel.request.seal(
            channel.aad(),
            &XNonce::generate(),
            &envelope.encode().unwrap(),
        )
    }

    fn request(sent_at: u64) -> Envelope<Value> {
        Envelope {
            id: Uuid::new_v4(),
            sent_at,
            body: json!({ "message": "hello" }),
        }
    }

    #[test]
    fn derives_vector_keys() {
        let vectors = vectors();
        let key = connector_key(&vectors);
        assert_eq!(
            hex::encode(Direction::Request.derive_key(&key)),
            vectors.request_key
        );
        assert_eq!(
            hex::encode(Direction::Response.derive_key(&key)),
            vectors.response_key
        );
    }

    #[test]
    fn matches_vector_messages() {
        let vectors = vectors();
        let channel = channel();
        for message in vectors.messages {
            let cipher = match message.direction {
                Direction::Request => &channel.request,
                Direction::Response => &channel.response,
            };
            let nonce = XNonce::try_from(hex::decode(&message.nonce).unwrap().as_slice()).unwrap();
            let plaintext = hex::decode(&message.plaintext).unwrap();
            let sealed = hex::decode(&message.sealed).unwrap();
            assert_eq!(cipher.seal(channel.aad(), &nonce, &plaintext), sealed);
            assert_eq!(cipher.open(channel.aad(), &sealed).unwrap(), plaintext);
            assert_eq!(
                Envelope::<Value>::decode(&plaintext).unwrap(),
                message.envelope
            );
        }
    }

    #[test]
    fn opens_fresh_requests_once() {
        let mut channel = channel();
        let envelope = request(1_000_000);
        let sealed = seal_request(&channel, &envelope);
        assert_eq!(
            channel
                .open_request_at::<Value>(&sealed, 1_000_000 + Channel::MAX_AGE_MS)
                .unwrap(),
            envelope
        );
        assert!(matches!(
            channel.open_request_at::<Value>(&sealed, 1_000_000),
            Err(Error::Replayed)
        ));
    }

    #[test]
    fn rejects_expired_requests() {
        let mut channel = channel();
        let sealed = seal_request(&channel, &request(1_000_000));
        assert!(matches!(
            channel.open_request_at::<Value>(&sealed, 1_000_001 + Channel::MAX_AGE_MS),
            Err(Error::Expired)
        ));
        assert!(matches!(
            channel.open_request_at::<Value>(&sealed, 999_999 - Channel::MAX_AGE_MS),
            Err(Error::Expired)
        ));
    }

    #[test]
    fn rejects_tampered_and_misaddressed_requests() {
        let mut channel = channel();
        let mut sealed = seal_request(&channel, &request(now_ms()));
        let mut other = Channel::new(&[7; 32], channel.connector_id.as_str());
        assert!(matches!(
            other.open_request::<Value>(&sealed),
            Err(Error::Undecryptable)
        ));
        other = Channel::new(&connector_key(&vectors()), "another-connector");
        assert!(matches!(
            other.open_request::<Value>(&sealed),
            Err(Error::Undecryptable)
        ));
        *sealed.last_mut().unwrap() ^= 1;
        assert!(matches!(
            channel.open_request::<Value>(&sealed),
            Err(Error::Undecryptable)
        ));
        assert!(matches!(
            channel.open_request::<Value>(&[2]),
            Err(Error::UnsupportedVersion(2))
        ));
        assert!(matches!(
            channel.open_request::<Value>(&[Cipher::VERSION]),
            Err(Error::Undecryptable)
        ));
    }

    #[test]
    fn compresses_large_responses() {
        let channel = channel();
        let id = Uuid::new_v4();
        for (body, encoding) in [
            (json!("small"), Encoding::Json),
            (
                json!("x".repeat(Encoding::COMPRESSION_THRESHOLD)),
                Encoding::Zstd,
            ),
        ] {
            let sealed = channel.seal_response(id, &body).unwrap();
            let plaintext = channel.response.open(channel.aad(), &sealed).unwrap();
            assert_eq!(Encoding::try_from(plaintext[0]).unwrap(), encoding);
            let envelope = Envelope::<Value>::decode(&plaintext).unwrap();
            assert_eq!((envelope.id, envelope.body), (id, body));
        }
    }
}
