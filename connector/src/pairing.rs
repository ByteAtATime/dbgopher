use std::str::FromStr;

use ed25519_dalek::VerifyingKey;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use uuid::Uuid;

use crate::decode_key;

const PROOF_LABEL: &[u8] = b"dbgopher/pair";

pub struct PairingCode {
    pub enrollment_token: String,
    secret: [u8; 32],
}

#[derive(Debug, thiserror::Error)]
#[error("PAIRING_CODE must be an enrollment token and 64 hex characters joined by a dot")]
pub struct InvalidPairingCode;

impl PairingCode {
    pub fn new(enrollment_token: String, secret: [u8; 32]) -> Self {
        Self {
            enrollment_token,
            secret,
        }
    }

    pub fn proof(&self, connector_id: Uuid, identity: &VerifyingKey) -> [u8; 32] {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(&self.secret).expect("HMAC accepts keys of any length");
        mac.update(PROOF_LABEL);
        mac.update(connector_id.as_bytes());
        mac.update(identity.as_bytes());
        mac.finalize().into_bytes().into()
    }
}

impl FromStr for PairingCode {
    type Err = InvalidPairingCode;

    fn from_str(code: &str) -> Result<Self, InvalidPairingCode> {
        let (enrollment_token, secret) = code.trim().split_once('.').ok_or(InvalidPairingCode)?;
        let secret = decode_key(secret).ok_or(InvalidPairingCode)?;
        if enrollment_token.is_empty() {
            return Err(InvalidPairingCode);
        }
        Ok(Self::new(enrollment_token.into(), secret))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::vectors::{self, bytes};

    #[test]
    fn matches_the_vector_proof() {
        let vectors = vectors::load();
        let code: PairingCode = format!("token.{}", vectors.pairing.secret).parse().unwrap();
        let identity = VerifyingKey::from_bytes(&bytes(&vectors.identity.public)).unwrap();
        assert_eq!(code.enrollment_token, "token");
        assert_eq!(
            hex::encode(code.proof(vectors.connector_id, &identity)),
            vectors.pairing.proof
        );
    }

    #[test]
    fn rejects_malformed_codes() {
        for code in [
            "",
            "token",
            ".",
            "token.abc",
            &format!(".{}", "ab".repeat(32)),
        ] {
            assert!(code.parse::<PairingCode>().is_err(), "{code}");
        }
    }
}
