use std::convert::Infallible;

use chacha20poly1305::aead::Aead as _;
use ed25519_dalek::{Signer, SigningKey};
use hpke::rand_core::{TryCryptoRng, TryRng};
use hpke::{Deserializable as _, OpModeS, Serializable as _};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::request::{SIGNATURE_LABEL, VERSION, info};
use super::response::{EXPORT_LABEL, NONCE_LEN, response_cipher};
use super::{Aead, Envelope, Kdf, Kem, SUITE};

pub struct Browser {
    user: SigningKey,
    config_hash: [u8; 32],
    prekey: <Kem as hpke::Kem>::PublicKey,
}

pub struct Sealed {
    pub header: Vec<u8>,
    pub enc: [u8; 32],
    pub frame: Vec<u8>,
    pub secret: [u8; 32],
}

pub struct FixedRng<'a>(pub &'a [u8]);

impl TryRng for FixedRng<'_> {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> Result<u32, Infallible> {
        unimplemented!("HPKE only fills byte buffers")
    }

    fn try_next_u64(&mut self) -> Result<u64, Infallible> {
        unimplemented!("HPKE only fills byte buffers")
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Infallible> {
        let (bytes, rest) = self.0.split_at(dst.len());
        dst.copy_from_slice(bytes);
        self.0 = rest;
        Ok(())
    }
}

impl TryCryptoRng for FixedRng<'_> {}

impl Browser {
    pub fn new(user: SigningKey, config: &[u8]) -> Self {
        let prekey_offset = 1 + 16 + SUITE.len();
        Self {
            user,
            config_hash: Sha256::digest(config).into(),
            prekey: <Kem as hpke::Kem>::PublicKey::from_bytes(
                &config[prekey_offset..prekey_offset + 32],
            )
            .unwrap(),
        }
    }

    pub fn seal(&self, envelope: &Envelope<Value>) -> Sealed {
        self.seal_plaintext(&envelope.encode().unwrap(), &rand::random())
    }

    pub fn seal_plaintext(&self, plaintext: &[u8], ikm_e: &[u8; 32]) -> Sealed {
        let header = [
            &[VERSION],
            SUITE.as_slice(),
            &self.config_hash,
            self.user.verifying_key().as_bytes(),
        ]
        .concat();
        let (enc, mut context) = hpke::setup_sender_with_rng::<Aead, Kdf, Kem>(
            &OpModeS::Base,
            &self.prekey,
            &info(&header),
            &mut FixedRng(ikm_e),
        )
        .unwrap();
        let ciphertext = context.seal(plaintext, b"").unwrap();
        let mut secret = [0; 32];
        context.export(EXPORT_LABEL, &mut secret).unwrap();
        let enc: [u8; 32] = enc.to_bytes().into();
        let frame = self.sign(&[header.as_slice(), &enc, &ciphertext].concat());
        Sealed {
            header,
            enc,
            frame,
            secret,
        }
    }

    pub fn sign(&self, signed: &[u8]) -> Vec<u8> {
        let signature = self.user.sign(&[SIGNATURE_LABEL, signed].concat());
        [signed, &signature.to_bytes()].concat()
    }
}

impl Sealed {
    pub fn open(&self, response: &[u8]) -> Envelope<Value> {
        Envelope::decode(&self.open_plaintext(response)).unwrap()
    }

    pub fn open_plaintext(&self, response: &[u8]) -> Vec<u8> {
        let (nonce, ciphertext) = response.split_first_chunk::<NONCE_LEN>().unwrap();
        let (cipher, iv) = response_cipher(&self.secret, &self.enc, nonce);
        cipher.decrypt(&iv, ciphertext).unwrap()
    }
}
