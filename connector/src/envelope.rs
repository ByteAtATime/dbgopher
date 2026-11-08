use std::borrow::Cow;
use std::time::{SystemTime, UNIX_EPOCH};

use hpke::Kem as _;
use hpke::aead::{Aead as _, ChaCha20Poly1305};
use hpke::kdf::{HkdfSha256, Kdf as _};
use hpke::kem::X25519HkdfSha256;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

#[cfg(test)]
mod browser;
mod gateway;
mod key_config;
mod request;
mod response;
#[cfg(test)]
pub(crate) mod vectors;

pub use gateway::{Gateway, Opened};
pub use key_config::SignedKeyConfig;
pub use response::Responder;

type Kem = X25519HkdfSha256;
type Kdf = HkdfSha256;
type Aead = ChaCha20Poly1305;

const SUITE: [u8; 6] = {
    let [kem_0, kem_1] = Kem::KEM_ID.to_be_bytes();
    let [kdf_0, kdf_1] = Kdf::KDF_ID.to_be_bytes();
    let [aead_0, aead_1] = Aead::AEAD_ID.to_be_bytes();
    [kem_0, kem_1, kdf_0, kdf_1, aead_0, aead_1]
};

#[derive(Debug, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Envelope<T> {
    pub id: Uuid,
    #[ts(type = "number")]
    pub sent_at: u64,
    pub body: T,
}

#[derive(Debug, PartialEq, Serialize, TS)]
#[serde(tag = "refusal", rename_all = "camelCase")]
#[ts(export)]
pub enum Refusal {
    Expired,
    Replayed,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("message is malformed")]
    Malformed,
    #[error("request was sealed for a key config the connector no longer holds")]
    StaleKey,
    #[error("request was not signed by an allowed user")]
    Unauthorized,
    #[error("message could not be decrypted")]
    Undecryptable,
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
    fn uses_the_vector_suite() {
        assert_eq!(hex::encode(SUITE), vectors::load().suite);
    }

    #[test]
    fn matches_rfc_9180_base_mode_vectors() {
        use hpke::{Deserializable as _, OpModeR, OpModeS, Serializable as _};

        let rfc = vectors::load().rfc9180;
        let decode = |hex: &str| hex::decode(hex).unwrap();
        let info = decode(&rfc.info);
        let recipient = <Kem as hpke::Kem>::PublicKey::from_bytes(&decode(&rfc.pk_rm)).unwrap();
        let (enc, mut sender) = hpke::setup_sender_with_rng::<Aead, Kdf, Kem>(
            &OpModeS::Base,
            &recipient,
            &info,
            &mut browser::FixedRng(&decode(&rfc.ikm_e)),
        )
        .unwrap();
        assert_eq!(hex::encode(enc.to_bytes()), rfc.enc);
        let ciphertext = sender.seal(&decode(&rfc.pt), &decode(&rfc.aad)).unwrap();
        assert_eq!(hex::encode(&ciphertext), rfc.ct);
        let secret = <Kem as hpke::Kem>::PrivateKey::from_bytes(&decode(&rfc.sk_rm)).unwrap();
        let mut receiver =
            hpke::setup_receiver::<Aead, Kdf, Kem>(&OpModeR::Base, &secret, &enc, &info).unwrap();
        assert_eq!(
            hex::encode(receiver.open(&ciphertext, &decode(&rfc.aad)).unwrap()),
            rfc.pt
        );
        for export in rfc.exports {
            let mut exported = vec![0; export.length];
            receiver
                .export(&decode(&export.context), &mut exported)
                .unwrap();
            assert_eq!(hex::encode(exported), export.value);
        }
    }

    #[test]
    fn decodes_vector_envelopes() {
        for message in vectors::load().envelopes {
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

    #[test]
    fn serializes_refusals_apart_from_responses() {
        assert_eq!(
            serde_json::to_value(Refusal::Expired).unwrap(),
            json!({ "refusal": "expired" })
        );
    }
}
