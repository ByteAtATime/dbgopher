use std::collections::HashMap;
use std::time::Duration;

use chacha20poly1305::XNonce;
use chacha20poly1305::aead::Generate;
use serde::Serialize;
use serde::de::DeserializeOwned;
use uuid::Uuid;
use x25519_dalek::{PublicKey, ReusableSecret};

use super::cipher::{Cipher, Direction, Frame, mac};
use super::{Envelope, Error, now_ms};

pub struct Responder {
    id: Uuid,
    cipher: Cipher,
    aad: String,
}

impl Responder {
    pub fn seal<T: Serialize>(&self, body: &T) -> Result<Vec<u8>, Error> {
        let envelope = Envelope {
            id: self.id,
            sent_at: now_ms(),
            body,
        };
        Ok(self.cipher.seal(
            self.aad.as_bytes(),
            &XNonce::generate(),
            &envelope.encode()?,
        ))
    }
}

struct Prekey {
    secret: ReusableSecret,
    public: PublicKey,
}

impl Prekey {
    fn random() -> Self {
        let secret = ReusableSecret::random();
        let public = PublicKey::from(&secret);
        Self { secret, public }
    }
}

struct Prekeys {
    current: Prekey,
    previous: Option<Prekey>,
}

impl Prekeys {
    fn find(&self, public: &[u8; 32]) -> Option<&Prekey> {
        std::iter::once(&self.current)
            .chain(&self.previous)
            .find(|prekey| prekey.public.as_bytes() == public)
    }
}

pub struct Channels {
    connector_key: [u8; 32],
    connector_id: String,
    prekeys: Prekeys,
    seen: HashMap<Uuid, u64>,
}

impl Channels {
    pub const ROTATION: Duration = Duration::from_secs(30 * 60);
    const MAX_AGE_MS: u64 = 60_000;

    pub fn new(connector_key: [u8; 32], connector_id: impl Into<String>) -> Self {
        Self {
            connector_key,
            connector_id: connector_id.into(),
            prekeys: Prekeys {
                current: Prekey::random(),
                previous: None,
            },
            seen: HashMap::new(),
        }
    }

    pub fn prekey(&self) -> [u8; 32] {
        self.prekeys.current.public.to_bytes()
    }

    pub fn rotate(&mut self) {
        let previous = std::mem::replace(&mut self.prekeys.current, Prekey::random());
        self.prekeys.previous = Some(previous);
    }

    pub fn open<T: DeserializeOwned>(
        &mut self,
        frame: &[u8],
    ) -> Result<(Envelope<T>, Responder), Error> {
        self.open_at(frame, now_ms())
    }

    fn open_at<T: DeserializeOwned>(
        &mut self,
        frame: &[u8],
        now: u64,
    ) -> Result<(Envelope<T>, Responder), Error> {
        let request = RequestFrame::parse(frame)?;
        let prekey = self
            .prekeys
            .find(request.prekey_public)
            .ok_or(Error::StaleKey)?;
        let browser_public = PublicKey::from(*request.browser_public);
        let shared = prekey.secret.diffie_hellman(&browser_public);
        if !shared.was_contributory() {
            return Err(Error::Malformed);
        }
        let key = session_key(
            &self.connector_key,
            browser_public.as_bytes(),
            prekey.public.as_bytes(),
            shared.as_bytes(),
        );
        let aad = self.connector_id.as_bytes();
        let plaintext = Cipher::new(&key, Direction::Request).open(aad, request.sealed)?;
        let envelope = Envelope::<T>::decode(&plaintext)?;
        let is_fresh = |sent_at: u64| now.abs_diff(sent_at) <= Self::MAX_AGE_MS;
        if !is_fresh(envelope.sent_at) {
            return Err(Error::Expired);
        }
        self.seen.retain(|_, &mut sent_at| is_fresh(sent_at));
        if self.seen.insert(envelope.id, envelope.sent_at).is_some() {
            return Err(Error::Replayed);
        }
        let responder = Responder {
            id: envelope.id,
            cipher: Cipher::new(&key, Direction::Response),
            aad: self.connector_id.clone(),
        };
        Ok((envelope, responder))
    }
}

struct RequestFrame<'a> {
    prekey_public: &'a [u8; 32],
    browser_public: &'a [u8; 32],
    sealed: &'a [u8],
}

impl<'a> RequestFrame<'a> {
    fn parse(frame: &'a [u8]) -> Result<Self, Error> {
        let (&kind, rest) = frame.split_first().ok_or(Error::Malformed)?;
        if kind != Frame::REQUEST {
            return Err(Error::UnsupportedFrame(kind));
        }
        let (prekey_public, rest) = rest.split_first_chunk().ok_or(Error::Malformed)?;
        let (browser_public, sealed) = rest.split_first_chunk().ok_or(Error::Malformed)?;
        Ok(Self {
            prekey_public,
            browser_public,
            sealed,
        })
    }
}

fn session_key(
    connector_key: &[u8; 32],
    browser_public: &[u8; 32],
    prekey_public: &[u8; 32],
    shared: &[u8; 32],
) -> [u8; 32] {
    mac(
        connector_key,
        &[b"dbgopher/session", browser_public, prekey_public, shared],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::vectors::{self, bytes};
    use serde_json::{Value, json};
    use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

    const CONNECTOR_ID: &str = "c0ffee00-0000-4000-8000-000000000000";
    const CONNECTOR_KEY: [u8; 32] = [9; 32];
    const NOW: u64 = 1_000_000;

    struct Browser {
        header: Vec<u8>,
        key: [u8; 32],
    }

    impl Browser {
        fn new(prekey_public: [u8; 32], connector_key: &[u8; 32]) -> Self {
            let secret: [u8; 32] = rand::random();
            let public = x25519(secret, X25519_BASEPOINT_BYTES);
            let shared = x25519(secret, prekey_public);
            Self {
                header: [&[Frame::REQUEST], prekey_public.as_slice(), &public].concat(),
                key: session_key(connector_key, &public, &prekey_public, &shared),
            }
        }

        fn seal(&self, envelope: &Envelope<Value>) -> Vec<u8> {
            let sealed = Cipher::new(&self.key, Direction::Request).seal(
                CONNECTOR_ID.as_bytes(),
                &XNonce::generate(),
                &envelope.encode().unwrap(),
            );
            [self.header.as_slice(), &sealed].concat()
        }

        fn open(&self, sealed: &[u8]) -> Envelope<Value> {
            let plaintext = Cipher::new(&self.key, Direction::Response)
                .open(CONNECTOR_ID.as_bytes(), sealed)
                .unwrap();
            Envelope::decode(&plaintext).unwrap()
        }
    }

    fn channels() -> Channels {
        Channels::new(CONNECTOR_KEY, CONNECTOR_ID)
    }

    fn browser(channels: &Channels) -> Browser {
        Browser::new(channels.prekey(), &CONNECTOR_KEY)
    }

    fn request(sent_at: u64) -> Envelope<Value> {
        Envelope {
            id: Uuid::new_v4(),
            sent_at,
            body: json!({ "message": "hello" }),
        }
    }

    fn open(channels: &mut Channels, frame: &[u8], now: u64) -> Result<Envelope<Value>, Error> {
        channels
            .open_at::<Value>(frame, now)
            .map(|(envelope, _)| envelope)
    }

    #[test]
    fn derives_the_vector_session_key() {
        let vectors = vectors::load();
        let prekey = &vectors.prekey;
        let browser_secret = bytes(&prekey.browser_secret);
        let prekey_secret = bytes(&prekey.prekey_secret);
        let browser_public = bytes(&prekey.browser_public);
        let prekey_public = bytes(&prekey.prekey_public);
        let shared = bytes(&prekey.shared);
        assert_eq!(
            x25519(browser_secret, X25519_BASEPOINT_BYTES),
            browser_public
        );
        assert_eq!(x25519(prekey_secret, X25519_BASEPOINT_BYTES), prekey_public);
        assert_eq!(x25519(browser_secret, prekey_public), shared);
        assert_eq!(x25519(prekey_secret, browser_public), shared);
        let key = session_key(
            &bytes(&vectors.connector_key),
            &browser_public,
            &prekey_public,
            &shared,
        );
        assert_eq!(hex::encode(key), prekey.session_key);
    }

    #[test]
    fn splits_the_vector_header() {
        let vectors = vectors::load();
        let prekey = &vectors.prekey;
        let header = hex::decode(&prekey.header).unwrap();
        let sealed = hex::decode(&vectors.messages[0].sealed).unwrap();
        let frame = [header.as_slice(), &sealed].concat();
        let request = RequestFrame::parse(&frame).unwrap();
        assert_eq!(hex::encode(request.prekey_public), prekey.prekey_public);
        assert_eq!(hex::encode(request.browser_public), prekey.browser_public);
        assert_eq!(request.sealed, sealed);
    }

    #[test]
    fn answers_a_request_with_a_response_the_browser_can_open() {
        let mut channels = channels();
        let browser = browser(&channels);
        let envelope = request(NOW);
        let (opened, responder) = channels
            .open_at::<Value>(&browser.seal(&envelope), NOW)
            .unwrap();
        assert_eq!(opened, envelope);
        let response = browser.open(&responder.seal(&json!("pong")).unwrap());
        assert_eq!((response.id, response.body), (envelope.id, json!("pong")));
    }

    #[test]
    fn rejects_frames_keyed_for_another_connector() {
        let mut channels = channels();
        let browser = Browser::new(channels.prekey(), &[7; 32]);
        assert!(matches!(
            open(&mut channels, &browser.seal(&request(NOW)), NOW),
            Err(Error::Undecryptable)
        ));
    }

    #[test]
    fn opens_with_the_previous_prekey_until_it_is_rotated_out() {
        let mut channels = channels();
        let browser = browser(&channels);
        channels.rotate();
        assert_ne!(channels.prekey(), browser.header[1..33]);
        assert!(open(&mut channels, &browser.seal(&request(NOW)), NOW).is_ok());
        channels.rotate();
        assert!(matches!(
            open(&mut channels, &browser.seal(&request(NOW)), NOW),
            Err(Error::StaleKey)
        ));
    }

    #[test]
    fn rejects_unknown_prekeys() {
        let mut channels = channels();
        let browser = Browser::new(rand::random(), &CONNECTOR_KEY);
        assert!(matches!(
            open(&mut channels, &browser.seal(&request(NOW)), NOW),
            Err(Error::StaleKey)
        ));
    }

    #[test]
    fn rejects_malformed_frames() {
        let mut channels = channels();
        let prekey = channels.prekey();
        let sealed = browser(&channels).seal(&request(NOW))[65..].to_vec();
        for frame in [
            vec![],
            vec![Frame::REQUEST],
            [&[Frame::REQUEST], [1; 31].as_slice()].concat(),
            [&[Frame::REQUEST], prekey.as_slice(), &[1; 31]].concat(),
            [&[Frame::REQUEST], prekey.as_slice(), &[0; 32], &sealed].concat(),
        ] {
            assert!(matches!(
                open(&mut channels, &frame, NOW),
                Err(Error::Malformed)
            ));
        }
        assert!(channels.seen.is_empty());
    }

    #[test]
    fn rejects_retired_handshake_frames() {
        let mut channels = channels();
        let frame = [&[2], channels.prekey().as_slice()].concat();
        assert!(matches!(
            open(&mut channels, &frame, NOW),
            Err(Error::UnsupportedFrame(2))
        ));
    }

    #[test]
    fn opens_fresh_requests_once() {
        let mut channels = channels();
        let envelope = request(NOW);
        let frame = browser(&channels).seal(&envelope);
        assert_eq!(
            open(&mut channels, &frame, NOW + Channels::MAX_AGE_MS).unwrap(),
            envelope
        );
        assert!(matches!(
            open(&mut channels, &frame, NOW),
            Err(Error::Replayed)
        ));
        let resealed = browser(&channels).seal(&envelope);
        assert!(matches!(
            open(&mut channels, &resealed, NOW),
            Err(Error::Replayed)
        ));
    }

    #[test]
    fn rejects_expired_requests() {
        let mut channels = channels();
        let frame = browser(&channels).seal(&request(NOW));
        assert!(matches!(
            open(&mut channels, &frame, NOW + 1 + Channels::MAX_AGE_MS),
            Err(Error::Expired)
        ));
        assert!(matches!(
            open(&mut channels, &frame, NOW - 1 - Channels::MAX_AGE_MS),
            Err(Error::Expired)
        ));
    }
}
