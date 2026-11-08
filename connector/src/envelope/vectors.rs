use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use super::Envelope;

const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../protocol/vectors.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Vectors {
    pub suite: String,
    pub rfc9180: Rfc9180,
    pub connector_id: Uuid,
    pub identity: KeyPair,
    pub user: KeyPair,
    pub pairing: Pairing,
    pub key_config: KeyConfig,
    pub request: Request,
    pub response: Response,
    pub envelopes: Vec<EncodedEnvelope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rfc9180 {
    pub info: String,
    pub ikm_e: String,
    pub sk_rm: String,
    pub pk_rm: String,
    pub enc: String,
    pub pt: String,
    pub aad: String,
    pub ct: String,
    pub exports: Vec<Export>,
}

#[derive(Deserialize)]
pub struct Export {
    pub context: String,
    pub length: usize,
    pub value: String,
}

#[derive(Deserialize)]
pub struct KeyPair {
    pub seed: String,
    pub public: String,
}

#[derive(Deserialize)]
pub struct Pairing {
    pub secret: String,
    pub proof: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyConfig {
    pub prekey_secret: String,
    pub prekey_public: String,
    pub expires_at: u64,
    pub config: String,
    pub signature: String,
    pub hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub ikm_e: String,
    pub plaintext: String,
    pub header: String,
    pub enc: String,
    pub frame: String,
}

#[derive(Deserialize)]
pub struct Response {
    pub nonce: String,
    pub plaintext: String,
    pub frame: String,
}

#[derive(Deserialize)]
pub struct EncodedEnvelope {
    pub envelope: Envelope<Value>,
    pub plaintext: String,
}

pub fn load() -> Vectors {
    serde_json::from_str(include_str!("../../../protocol/vectors.json")).unwrap()
}

pub fn bytes<const N: usize>(hex: &str) -> [u8; N] {
    hex::decode(hex).unwrap().try_into().unwrap()
}

#[cfg(test)]
mod generate {
    use std::fs;

    use ed25519_dalek::SigningKey;
    use hpke::{Deserializable as _, Kem as _, Serializable as _};
    use serde::Serialize;
    use serde_json::ser::PrettyFormatter;
    use serde_json::{Value, json};

    use super::{PATH, bytes, load};
    use crate::envelope::Kem;
    use crate::envelope::browser::Browser;
    use crate::envelope::key_config::KeyConfig;
    use crate::envelope::response::Responder;
    use crate::pairing::PairingCode;

    #[test]
    #[ignore = "rewrites protocol/vectors.json from its inputs"]
    fn write_vectors() {
        let vectors = load();
        let mut file: Value = serde_json::from_str(&fs::read_to_string(PATH).unwrap()).unwrap();
        let identity = SigningKey::from_bytes(&bytes(&vectors.identity.seed));
        let user = SigningKey::from_bytes(&bytes(&vectors.user.seed));
        let prekey = <Kem as hpke::Kem>::PrivateKey::from_bytes(
            &hex::decode(&vectors.key_config.prekey_secret).unwrap(),
        )
        .unwrap();
        let prekey_public: [u8; 32] = Kem::sk_to_pk(&prekey).to_bytes().into();
        let config = KeyConfig::new(
            vectors.connector_id,
            &prekey_public,
            vectors.key_config.expires_at,
        );
        let signed = config.sign(&identity);
        let request = Browser::new(user.clone(), &signed.config).seal_plaintext(
            &hex::decode(&vectors.request.plaintext).unwrap(),
            &bytes(&vectors.request.ikm_e),
        );
        let request_envelope = vectors.envelopes[0].envelope.id;
        let response = Responder::new(request_envelope, request.secret, request.enc)
            .seal_with_nonce(
                &hex::decode(&vectors.response.plaintext).unwrap(),
                &bytes(&vectors.response.nonce),
            );
        let pairing = PairingCode::new(String::new(), bytes(&vectors.pairing.secret));
        merge(
            &mut file,
            json!({
                "identity": { "public": hex::encode(identity.verifying_key().as_bytes()) },
                "user": { "public": hex::encode(user.verifying_key().as_bytes()) },
                "pairing": {
                    "proof": hex::encode(pairing.proof(vectors.connector_id, &identity.verifying_key()))
                },
                "keyConfig": {
                    "prekeyPublic": hex::encode(prekey_public),
                    "config": hex::encode(&signed.config),
                    "signature": hex::encode(signed.signature.to_bytes()),
                    "hash": hex::encode(config.hash()),
                },
                "request": {
                    "header": hex::encode(&request.header),
                    "enc": hex::encode(request.enc),
                    "frame": hex::encode(&request.frame),
                },
                "response": { "frame": hex::encode(response) },
            }),
        );
        let mut json = Vec::new();
        file.serialize(&mut serde_json::Serializer::with_formatter(
            &mut json,
            PrettyFormatter::with_indent(b"\t"),
        ))
        .unwrap();
        json.push(b'\n');
        fs::write(PATH, json).unwrap();
    }

    fn merge(target: &mut Value, patch: Value) {
        match (target, patch) {
            (Value::Object(target), Value::Object(patch)) => {
                for (key, value) in patch {
                    merge(target.entry(key).or_insert(Value::Null), value);
                }
            }
            (target, patch) => *target = patch,
        }
    }
}
