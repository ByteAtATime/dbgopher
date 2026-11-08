use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use serde::Serialize;
use sha2::Sha256;
use uuid::Uuid;

use super::{Envelope, Error, now_ms};

pub(super) const EXPORT_LABEL: &[u8] = b"dbgopher/response";
pub(super) const NONCE_LEN: usize = 32;

pub struct Responder {
    id: Uuid,
    secret: [u8; 32],
    enc: [u8; 32],
}

impl Responder {
    pub(super) fn new(id: Uuid, secret: [u8; 32], enc: [u8; 32]) -> Self {
        Self { id, secret, enc }
    }

    pub fn seal<T: Serialize>(&self, body: &T) -> Result<Vec<u8>, Error> {
        let envelope = Envelope {
            id: self.id,
            sent_at: now_ms(),
            body,
        };
        Ok(self.seal_with_nonce(&envelope.encode()?, &rand::random()))
    }

    pub(super) fn seal_with_nonce(&self, plaintext: &[u8], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
        let (cipher, iv) = response_cipher(&self.secret, &self.enc, nonce);
        let ciphertext = cipher
            .encrypt(&iv, plaintext)
            .expect("plaintext fits in a single ChaCha20-Poly1305 message");
        [nonce.as_slice(), &ciphertext].concat()
    }
}

pub(super) fn response_cipher(
    secret: &[u8; 32],
    enc: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
) -> (ChaCha20Poly1305, Nonce) {
    let (_, hkdf) = Hkdf::<Sha256>::extract(Some(&[enc.as_slice(), nonce].concat()), secret);
    let mut key = Key::default();
    let mut iv = Nonce::default();
    hkdf.expand(b"key", &mut key)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    hkdf.expand(b"nonce", &mut iv)
        .expect("12 bytes is a valid HKDF-SHA256 output length");
    (ChaCha20Poly1305::new(&key), iv)
}
