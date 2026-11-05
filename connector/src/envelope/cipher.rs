use blake2::Blake2bMac;
use blake2::digest::{Mac, consts::U32};
use chacha20poly1305::aead::{Aead, Key, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};

use super::Error;

pub(super) struct Frame;

impl Frame {
    pub(super) const SEALED: u8 = 1;
    pub(super) const REQUEST: u8 = 3;
}

pub(super) fn mac(key: &[u8; 32], parts: &[&[u8]]) -> [u8; 32] {
    let mut mac =
        Blake2bMac::<U32>::new_from_slice(key).expect("32-byte keys are valid BLAKE2b keys");
    for part in parts {
        mac.update(part);
    }
    mac.finalize().into_bytes().into()
}

#[derive(Clone, Copy)]
#[cfg_attr(test, derive(serde::Deserialize), serde(rename_all = "lowercase"))]
pub(super) enum Direction {
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

    fn derive_key(self, session_key: &[u8; 32]) -> Key<XChaCha20Poly1305> {
        mac(session_key, &[self.label()]).into()
    }
}

#[derive(Clone)]
pub(super) struct Cipher(XChaCha20Poly1305);

impl Cipher {
    const NONCE_LEN: usize = 24;

    pub(super) fn new(session_key: &[u8; 32], direction: Direction) -> Self {
        Self(XChaCha20Poly1305::new(&direction.derive_key(session_key)))
    }

    pub(super) fn seal(&self, aad: &[u8], nonce: &XNonce, plaintext: &[u8]) -> Vec<u8> {
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
        [&[Frame::SEALED], nonce.as_slice(), &ciphertext].concat()
    }

    pub(super) fn open(&self, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>, Error> {
        let (&kind, rest) = sealed.split_first().ok_or(Error::Undecryptable)?;
        if kind != Frame::SEALED {
            return Err(Error::UnsupportedFrame(kind));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::vectors::{self, bytes};
    use chacha20poly1305::aead::Generate;

    const AAD: &[u8] = b"connector";

    #[test]
    fn derives_vector_keys() {
        let vectors = vectors::load();
        let key = bytes(&vectors.prekey.session_key);
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
        let vectors = vectors::load();
        let key = bytes(&vectors.prekey.session_key);
        for message in vectors.messages {
            let cipher = Cipher::new(&key, message.direction);
            let aad = vectors.connector_id.as_bytes();
            let nonce = XNonce::try_from(hex::decode(&message.nonce).unwrap().as_slice()).unwrap();
            let plaintext = hex::decode(&message.plaintext).unwrap();
            let sealed = hex::decode(&message.sealed).unwrap();
            assert_eq!(cipher.seal(aad, &nonce, &plaintext), sealed);
            assert_eq!(cipher.open(aad, &sealed).unwrap(), plaintext);
        }
    }

    #[test]
    fn rejects_tampered_and_misaddressed_frames() {
        let cipher = Cipher::new(&[1; 32], Direction::Request);
        let mut sealed = cipher.seal(AAD, &XNonce::generate(), b"hello");
        for (cipher, aad) in [
            (&cipher, b"another-connector".as_slice()),
            (&Cipher::new(&[2; 32], Direction::Request), AAD),
            (&Cipher::new(&[1; 32], Direction::Response), AAD),
        ] {
            assert!(matches!(
                cipher.open(aad, &sealed),
                Err(Error::Undecryptable)
            ));
        }
        *sealed.last_mut().unwrap() ^= 1;
        assert!(matches!(
            cipher.open(AAD, &sealed),
            Err(Error::Undecryptable)
        ));
        assert!(matches!(
            cipher.open(AAD, &[3]),
            Err(Error::UnsupportedFrame(3))
        ));
        assert!(matches!(
            cipher.open(AAD, &[Frame::SEALED]),
            Err(Error::Undecryptable)
        ));
    }
}
