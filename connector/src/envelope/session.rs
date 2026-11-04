use std::collections::HashMap;
use std::time::{Duration, Instant};

use chacha20poly1305::XNonce;
use chacha20poly1305::aead::Generate;
use serde::Serialize;
use serde::de::DeserializeOwned;
use uuid::Uuid;
use x25519_dalek::{EphemeralSecret, PublicKey};

use super::cipher::{Cipher, Direction, Frame, mac};
use super::{Envelope, Error, now_ms};

#[derive(Clone, Copy)]
struct Now {
    wall_ms: u64,
    instant: Instant,
}

impl Now {
    fn current() -> Self {
        Self {
            wall_ms: now_ms(),
            instant: Instant::now(),
        }
    }
}

pub enum Opened<T> {
    Handshake(Vec<u8>),
    Request(Envelope<T>, Responder),
}

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

pub struct Channels {
    connector_key: [u8; 32],
    connector_id: String,
    live: HashMap<String, Live>,
}

struct Live {
    expires_at: Instant,
    channel: Channel,
}

impl Channels {
    const MAX_AGE: Duration = Duration::from_secs(60 * 60);
    const MAX_LIVE: usize = 256;

    pub fn new(connector_key: [u8; 32], connector_id: impl Into<String>) -> Self {
        Self {
            connector_key,
            connector_id: connector_id.into(),
            live: HashMap::new(),
        }
    }

    pub fn open<T: DeserializeOwned>(
        &mut self,
        session_id: &str,
        frame: &[u8],
    ) -> Result<Opened<T>, Error> {
        self.open_at(session_id, frame, Now::current())
    }

    fn open_at<T: DeserializeOwned>(
        &mut self,
        session_id: &str,
        frame: &[u8],
        now: Now,
    ) -> Result<Opened<T>, Error> {
        if let [Frame::HANDSHAKE, browser_public @ ..] = frame {
            let browser_public = PublicKey::from(
                <[u8; 32]>::try_from(browser_public).map_err(|_| Error::Malformed)?,
            );
            return self.handshake(session_id, &browser_public, now);
        }
        let live = self
            .live
            .get_mut(session_id)
            .filter(|live| now.instant < live.expires_at)
            .ok_or(Error::UnknownSession)?;
        let envelope = live.channel.open_request_at(frame, now.wall_ms)?;
        let responder = live.channel.responder(envelope.id);
        Ok(Opened::Request(envelope, responder))
    }

    fn handshake<T>(
        &mut self,
        session_id: &str,
        browser_public: &PublicKey,
        now: Now,
    ) -> Result<Opened<T>, Error> {
        let secret = EphemeralSecret::random();
        let connector_public = PublicKey::from(&secret);
        let shared = secret.diffie_hellman(browser_public);
        if !shared.was_contributory() {
            return Err(Error::Malformed);
        }
        let key = session_key(
            &self.connector_key,
            session_id,
            browser_public.as_bytes(),
            connector_public.as_bytes(),
            shared.as_bytes(),
        );
        self.live.retain(|_, live| now.instant < live.expires_at);
        if self.live.len() >= Self::MAX_LIVE
            && let Some(oldest) = self
                .live
                .iter()
                .min_by_key(|(_, live)| live.expires_at)
                .map(|(id, _)| id.clone())
        {
            self.live.remove(&oldest);
        }
        self.live.insert(
            session_id.into(),
            Live {
                expires_at: now.instant + Self::MAX_AGE,
                channel: Channel::new(&key, self.connector_id.as_str()),
            },
        );
        Ok(Opened::Handshake(connector_public.as_bytes().to_vec()))
    }
}

struct Channel {
    connector_id: String,
    request: Cipher,
    response: Cipher,
    seen: HashMap<Uuid, u64>,
}

impl Channel {
    const MAX_AGE_MS: u64 = 60_000;

    fn new(session_key: &[u8; 32], connector_id: impl Into<String>) -> Self {
        Self {
            connector_id: connector_id.into(),
            request: Cipher::new(session_key, Direction::Request),
            response: Cipher::new(session_key, Direction::Response),
            seen: HashMap::new(),
        }
    }

    fn responder(&self, id: Uuid) -> Responder {
        Responder {
            id,
            cipher: self.response.clone(),
            aad: self.connector_id.clone(),
        }
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

fn session_key(
    connector_key: &[u8; 32],
    session_id: &str,
    browser_public: &[u8; 32],
    connector_public: &[u8; 32],
    shared: &[u8; 32],
) -> [u8; 32] {
    mac(
        connector_key,
        &[
            b"dbgopher/session",
            session_id.as_bytes(),
            browser_public,
            connector_public,
            shared,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::vectors::{self, bytes};
    use serde_json::{Value, json};
    use std::sync::LazyLock;
    use x25519_dalek::{X25519_BASEPOINT_BYTES, x25519};

    const CONNECTOR_ID: &str = "c0ffee00-0000-4000-8000-000000000000";
    const CONNECTOR_KEY: [u8; 32] = [9; 32];
    const SESSION_ID: &str = "session";

    fn at(wall_ms: u64) -> Now {
        static START: LazyLock<Instant> = LazyLock::new(Instant::now);
        Now {
            wall_ms,
            instant: *START + Duration::from_millis(wall_ms),
        }
    }

    fn channels() -> Channels {
        Channels::new(CONNECTOR_KEY, CONNECTOR_ID)
    }

    fn connect(channels: &mut Channels, session_id: &str, now: u64) -> Channel {
        let secret = [5; 32];
        let browser_public = x25519(secret, X25519_BASEPOINT_BYTES);
        let frame = [&[Frame::HANDSHAKE], browser_public.as_slice()].concat();
        let Opened::Handshake(connector_public) = channels
            .open_at::<Value>(session_id, &frame, at(now))
            .unwrap()
        else {
            panic!("expected a handshake response");
        };
        let connector_public: [u8; 32] = connector_public.try_into().unwrap();
        let key = session_key(
            &CONNECTOR_KEY,
            session_id,
            &browser_public,
            &connector_public,
            &x25519(secret, connector_public),
        );
        Channel::new(&key, CONNECTOR_ID)
    }

    fn seal_request(browser: &Channel, envelope: &Envelope<Value>) -> Vec<u8> {
        browser.request.seal(
            browser.aad(),
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

    fn open(channels: &mut Channels, sealed: &[u8], now: u64) -> Result<Envelope<Value>, Error> {
        match channels.open_at::<Value>(SESSION_ID, sealed, at(now))? {
            Opened::Request(envelope, _) => Ok(envelope),
            Opened::Handshake(_) => panic!("expected a request"),
        }
    }

    #[test]
    fn derives_the_vector_session_key() {
        let vectors = vectors::load();
        let handshake = &vectors.handshake;
        let browser_secret = bytes(&handshake.browser_secret);
        let connector_secret = bytes(&handshake.connector_secret);
        let browser_public = bytes(&handshake.browser_public);
        let connector_public = bytes(&handshake.connector_public);
        let shared = bytes(&handshake.shared);
        assert_eq!(
            x25519(browser_secret, X25519_BASEPOINT_BYTES),
            browser_public
        );
        assert_eq!(
            x25519(connector_secret, X25519_BASEPOINT_BYTES),
            connector_public
        );
        assert_eq!(x25519(browser_secret, connector_public), shared);
        assert_eq!(x25519(connector_secret, browser_public), shared);
        let key = session_key(
            &bytes(&vectors.connector_key),
            &handshake.session_id,
            &browser_public,
            &connector_public,
            &shared,
        );
        assert_eq!(hex::encode(key), handshake.session_key);
    }

    #[test]
    fn accepts_the_vector_handshake_frame() {
        let vectors = vectors::load();
        let handshake = &vectors.handshake;
        let browser_public = bytes(&handshake.browser_public);
        assert_eq!(
            hex::encode([&[Frame::HANDSHAKE], browser_public.as_slice()].concat()),
            handshake.frame
        );
        let mut channels = Channels::new(bytes(&vectors.connector_key), vectors.connector_id);
        assert!(matches!(
            channels.open_at::<Value>(
                &handshake.session_id,
                &hex::decode(&handshake.frame).unwrap(),
                at(1_000_000)
            ),
            Ok(Opened::Handshake(public)) if public.len() == 32
        ));
    }

    #[test]
    fn answers_requests_over_a_handshaken_session() {
        let mut channels = channels();
        let browser = connect(&mut channels, SESSION_ID, 1_000_000);
        let envelope = request(1_000_000);
        let Opened::Request(opened, responder) = channels
            .open_at::<Value>(
                SESSION_ID,
                &seal_request(&browser, &envelope),
                at(1_000_000),
            )
            .unwrap()
        else {
            panic!("expected a request");
        };
        assert_eq!(opened, envelope);
        let sealed = responder.seal(&json!("pong")).unwrap();
        let response =
            Envelope::<Value>::decode(&browser.response.open(browser.aad(), &sealed).unwrap())
                .unwrap();
        assert_eq!((response.id, response.body), (envelope.id, json!("pong")));
    }

    #[test]
    fn derives_distinct_keys_per_session() {
        let mut channels = channels();
        let first = connect(&mut channels, SESSION_ID, 1_000_000);
        connect(&mut channels, SESSION_ID, 1_000_000);
        assert!(matches!(
            open(
                &mut channels,
                &seal_request(&first, &request(1_000_000)),
                1_000_000
            ),
            Err(Error::Undecryptable)
        ));
    }

    #[test]
    fn rejects_sessions_keyed_for_another_connector() {
        let mut channels = channels();
        let mut other = Channels::new([7; 32], CONNECTOR_ID);
        let browser = connect(&mut other, SESSION_ID, 1_000_000);
        connect(&mut channels, SESSION_ID, 1_000_000);
        assert!(matches!(
            open(
                &mut channels,
                &seal_request(&browser, &request(1_000_000)),
                1_000_000
            ),
            Err(Error::Undecryptable)
        ));
    }

    #[test]
    fn rejects_unknown_and_expired_sessions() {
        let mut channels = channels();
        let browser = connect(&mut channels, "another-session", 1_000_000);
        let sealed = seal_request(&browser, &request(1_000_000));
        assert!(matches!(
            open(&mut channels, &sealed, 1_000_000),
            Err(Error::UnknownSession)
        ));

        let browser = connect(&mut channels, SESSION_ID, 1_000_000);
        let expires_at = 1_000_000 + Channels::MAX_AGE.as_secs() * 1000;
        let sealed = seal_request(&browser, &request(expires_at - 1));
        assert!(open(&mut channels, &sealed, expires_at - 1).is_ok());
        let sealed = seal_request(&browser, &request(expires_at));
        assert!(matches!(
            open(&mut channels, &sealed, expires_at),
            Err(Error::UnknownSession)
        ));
    }

    #[test]
    fn evicts_the_oldest_session_when_full() {
        let mut channels = channels();
        let oldest = connect(&mut channels, SESSION_ID, 1_000_000);
        for index in 1..=Channels::MAX_LIVE {
            connect(&mut channels, &index.to_string(), 1_000_001);
        }
        assert_eq!(channels.live.len(), Channels::MAX_LIVE);
        assert!(matches!(
            open(
                &mut channels,
                &seal_request(&oldest, &request(1_000_001)),
                1_000_001
            ),
            Err(Error::UnknownSession)
        ));
    }

    #[test]
    fn rejects_malformed_handshakes() {
        let mut channels = channels();
        for frame in [
            vec![Frame::HANDSHAKE],
            [&[Frame::HANDSHAKE], [1; 31].as_slice()].concat(),
            [&[Frame::HANDSHAKE], [0; 32].as_slice()].concat(),
        ] {
            assert!(matches!(
                channels.open_at::<Value>(SESSION_ID, &frame, at(1_000_000)),
                Err(Error::Malformed)
            ));
        }
        assert!(channels.live.is_empty());
    }

    #[test]
    fn opens_fresh_requests_once() {
        let mut channels = channels();
        let browser = connect(&mut channels, SESSION_ID, 1_000_000);
        let envelope = request(1_000_000);
        let sealed = seal_request(&browser, &envelope);
        assert_eq!(
            open(&mut channels, &sealed, 1_000_000 + Channel::MAX_AGE_MS).unwrap(),
            envelope
        );
        assert!(matches!(
            open(&mut channels, &sealed, 1_000_000),
            Err(Error::Replayed)
        ));
    }

    #[test]
    fn rejects_expired_requests() {
        let mut channels = channels();
        let browser = connect(&mut channels, SESSION_ID, 1_000_000);
        let sealed = seal_request(&browser, &request(1_000_000));
        assert!(matches!(
            open(&mut channels, &sealed, 1_000_001 + Channel::MAX_AGE_MS),
            Err(Error::Expired)
        ));
        assert!(matches!(
            open(&mut channels, &sealed, 999_999 - Channel::MAX_AGE_MS),
            Err(Error::Expired)
        ));
    }
}
