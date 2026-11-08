use ed25519_dalek::{Signature, Signer, SigningKey};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::SUITE;

const SIGNATURE_LABEL: &[u8] = b"dbgopher/key-config";
const LEN: usize = 16 + SUITE.len() + 32 + 8;

pub(super) struct KeyConfig([u8; LEN]);

impl KeyConfig {
    pub(super) fn new(connector_id: Uuid, prekey: &[u8; 32], expires_at: u64) -> Self {
        let bytes = [
            connector_id.as_bytes().as_slice(),
            &SUITE,
            prekey,
            &expires_at.to_be_bytes(),
        ]
        .concat();
        Self(
            bytes
                .try_into()
                .expect("key config fields add up to its length"),
        )
    }

    pub(super) fn hash(&self) -> [u8; 32] {
        Sha256::digest(self.0).into()
    }

    pub(super) fn sign(&self, identity: &SigningKey) -> SignedKeyConfig {
        SignedKeyConfig {
            config: self.0.to_vec(),
            signature: identity.sign(&[SIGNATURE_LABEL, &self.0].concat()),
        }
    }
}

#[derive(Clone)]
pub struct SignedKeyConfig {
    pub config: Vec<u8>,
    pub signature: Signature,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::vectors::{self, bytes};
    use ed25519_dalek::{Verifier, VerifyingKey};

    #[test]
    fn matches_the_vector_key_config() {
        let vectors = vectors::load();
        let key_config = &vectors.key_config;
        let config = KeyConfig::new(
            vectors.connector_id,
            &bytes(&key_config.prekey_public),
            key_config.expires_at,
        );
        assert_eq!(hex::encode(config.0), key_config.config);
        assert_eq!(hex::encode(config.hash()), key_config.hash);
        let identity = SigningKey::from_bytes(&bytes(&vectors.identity.seed));
        assert_eq!(
            hex::encode(identity.verifying_key().as_bytes()),
            vectors.identity.public
        );
        let signed = config.sign(&identity);
        assert_eq!(
            hex::encode(signed.signature.to_bytes()),
            key_config.signature
        );
    }

    #[test]
    fn signs_under_its_own_label() {
        let identity = SigningKey::from_bytes(&[7; 32]);
        let config = KeyConfig::new(Uuid::nil(), &[1; 32], 0);
        let signed = config.sign(&identity);
        let key = VerifyingKey::from(&identity);
        assert!(
            key.verify(&[SIGNATURE_LABEL, &config.0].concat(), &signed.signature)
                .is_ok()
        );
        assert!(key.verify(&config.0, &signed.signature).is_err());
    }
}
