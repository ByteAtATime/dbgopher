use std::collections::HashMap;
use std::time::Duration;

use ed25519_dalek::{SigningKey, VerifyingKey};
use hpke::{Deserializable as _, Kem as _, OpModeR, Serializable as _};
use serde::de::DeserializeOwned;
use uuid::Uuid;

use super::key_config::{KeyConfig, SignedKeyConfig};
use super::request::RequestFrame;
use super::response::{EXPORT_LABEL, Responder};
use super::{Aead, Envelope, Error, Kdf, Kem, Refusal, now_ms};

pub struct Opened<T> {
    pub responder: Responder,
    pub envelope: Result<Envelope<T>, Refusal>,
}

struct Prekey {
    secret: <Kem as hpke::Kem>::PrivateKey,
    hash: [u8; 32],
    signed: SignedKeyConfig,
}

impl Prekey {
    fn new(identity: &SigningKey, connector_id: Uuid, now: u64) -> Self {
        let (secret, public) = Kem::gen_keypair();
        let config = KeyConfig::new(
            connector_id,
            &public.to_bytes().into(),
            now + Gateway::KEY_LIFETIME_MS,
        );
        Self {
            secret,
            hash: config.hash(),
            signed: config.sign(identity),
        }
    }
}

pub struct Gateway {
    identity: SigningKey,
    connector_id: Uuid,
    users: Vec<VerifyingKey>,
    current: Prekey,
    previous: Option<Prekey>,
    seen: HashMap<Uuid, u64>,
}

impl Gateway {
    pub const ROTATION: Duration = Duration::from_secs(30 * 60);
    const KEY_LIFETIME_MS: u64 = 2 * Self::ROTATION.as_millis() as u64;
    const MAX_AGE_MS: u64 = 60_000;

    pub fn new(identity: SigningKey, connector_id: Uuid, users: Vec<VerifyingKey>) -> Self {
        let current = Prekey::new(&identity, connector_id, now_ms());
        Self {
            identity,
            connector_id,
            users,
            current,
            previous: None,
            seen: HashMap::new(),
        }
    }

    pub fn key_config(&self) -> &SignedKeyConfig {
        &self.current.signed
    }

    pub fn rotate(&mut self) {
        let next = Prekey::new(&self.identity, self.connector_id, now_ms());
        self.previous = Some(std::mem::replace(&mut self.current, next));
    }

    pub fn open<T: DeserializeOwned>(&mut self, frame: &[u8]) -> Result<Opened<T>, Error> {
        self.open_at(frame, now_ms())
    }

    fn open_at<T: DeserializeOwned>(&mut self, frame: &[u8], now: u64) -> Result<Opened<T>, Error> {
        let request = RequestFrame::parse(frame)?;
        let prekey = std::iter::once(&self.current)
            .chain(&self.previous)
            .find(|prekey| prekey.hash == *request.config_hash)
            .ok_or(Error::StaleKey)?;
        let user = self
            .users
            .iter()
            .find(|user| user.as_bytes() == request.user_key)
            .ok_or(Error::Unauthorized)?;
        if !request.is_signed_by(user) {
            return Err(Error::Unauthorized);
        }
        let enc = <Kem as hpke::Kem>::EncappedKey::from_bytes(request.enc)
            .map_err(|_| Error::Malformed)?;
        let mut context = hpke::setup_receiver::<Aead, Kdf, Kem>(
            &OpModeR::Base,
            &prekey.secret,
            &enc,
            &request.info(),
        )
        .map_err(|_| Error::Undecryptable)?;
        let plaintext = context
            .open(request.ciphertext, b"")
            .map_err(|_| Error::Undecryptable)?;
        let mut secret = [0; 32];
        context
            .export(EXPORT_LABEL, &mut secret)
            .expect("32 bytes is a valid HKDF-SHA256 export length");
        let envelope = Envelope::<T>::decode(&plaintext)?;
        let responder = Responder::new(envelope.id, secret, *request.enc);
        Ok(Opened {
            responder,
            envelope: self.admit(envelope, now),
        })
    }

    fn admit<T>(&mut self, envelope: Envelope<T>, now: u64) -> Result<Envelope<T>, Refusal> {
        let is_fresh = |sent_at: u64| now.abs_diff(sent_at) <= Self::MAX_AGE_MS;
        if !is_fresh(envelope.sent_at) {
            return Err(Refusal::Expired);
        }
        self.seen.retain(|_, &mut sent_at| is_fresh(sent_at));
        if self.seen.insert(envelope.id, envelope.sent_at).is_some() {
            return Err(Refusal::Replayed);
        }
        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::browser::Browser;
    use crate::envelope::vectors::{self, bytes};
    use serde_json::{Value, json};

    const NOW: u64 = 1_000_000;

    fn identity() -> SigningKey {
        SigningKey::from_bytes(&[1; 32])
    }

    fn user() -> SigningKey {
        SigningKey::from_bytes(&[2; 32])
    }

    fn gateway() -> Gateway {
        Gateway::new(identity(), Uuid::nil(), vec![user().verifying_key()])
    }

    fn browser(gateway: &Gateway) -> Browser {
        Browser::new(user(), &gateway.key_config().config)
    }

    fn request(sent_at: u64) -> Envelope<Value> {
        Envelope {
            id: Uuid::new_v4(),
            sent_at,
            body: json!({ "message": "hello" }),
        }
    }

    fn open(gateway: &mut Gateway, frame: &[u8], now: u64) -> Result<Opened<Value>, Error> {
        gateway.open_at::<Value>(frame, now)
    }

    fn accepted(gateway: &mut Gateway, frame: &[u8], now: u64) -> Result<Envelope<Value>, Error> {
        open(gateway, frame, now).map(|opened| opened.envelope.unwrap())
    }

    fn refusal(gateway: &mut Gateway, frame: &[u8], now: u64) -> Refusal {
        open(gateway, frame, now).unwrap().envelope.unwrap_err()
    }

    #[test]
    fn opens_the_vector_request_and_seals_the_vector_response() {
        let vectors = vectors::load();
        let identity = SigningKey::from_bytes(&bytes(&vectors.identity.seed));
        let user = SigningKey::from_bytes(&bytes(&vectors.user.seed));
        let config = KeyConfig::new(
            vectors.connector_id,
            &bytes(&vectors.key_config.prekey_public),
            vectors.key_config.expires_at,
        );
        let current = Prekey {
            secret: <Kem as hpke::Kem>::PrivateKey::from_bytes(
                &hex::decode(&vectors.key_config.prekey_secret).unwrap(),
            )
            .unwrap(),
            hash: config.hash(),
            signed: config.sign(&identity),
        };
        let mut gateway = Gateway {
            identity,
            connector_id: vectors.connector_id,
            users: vec![user.verifying_key()],
            current,
            previous: None,
            seen: HashMap::new(),
        };
        let expected = &vectors.envelopes[0].envelope;
        let frame = hex::decode(&vectors.request.frame).unwrap();
        let Opened {
            responder,
            envelope,
        } = open(&mut gateway, &frame, expected.sent_at).unwrap();
        assert_eq!(&envelope.unwrap(), expected);
        let response = responder.seal_with_nonce(
            &hex::decode(&vectors.response.plaintext).unwrap(),
            &bytes(&vectors.response.nonce),
        );
        assert_eq!(hex::encode(response), vectors.response.frame);
    }

    #[test]
    fn answers_a_request_with_a_response_the_browser_can_open() {
        let mut gateway = gateway();
        let envelope = request(NOW);
        let sealed = browser(&gateway).seal(&envelope);
        let Opened {
            responder,
            envelope: opened,
        } = open(&mut gateway, &sealed.frame, NOW).unwrap();
        assert_eq!(opened.unwrap(), envelope);
        let response = sealed.open(&responder.seal(&json!("pong")).unwrap());
        assert_eq!((response.id, response.body), (envelope.id, json!("pong")));
    }

    #[test]
    fn rejects_users_missing_from_the_allowlist() {
        let mut gateway = gateway();
        let stranger = Browser::new(
            SigningKey::from_bytes(&[3; 32]),
            &gateway.key_config().config,
        );
        assert!(matches!(
            accepted(&mut gateway, &stranger.seal(&request(NOW)).frame, NOW),
            Err(Error::Unauthorized)
        ));
    }

    #[test]
    fn rejects_frames_whose_signature_does_not_match() {
        let mut gateway = gateway();
        let mut frame = browser(&gateway).seal(&request(NOW)).frame;
        let last = frame.len() - 1;
        frame[last] ^= 1;
        assert!(matches!(
            accepted(&mut gateway, &frame, NOW),
            Err(Error::Unauthorized)
        ));
    }

    #[test]
    fn rejects_signed_frames_that_do_not_decrypt() {
        let mut gateway = gateway();
        let browser = browser(&gateway);
        let frame = browser.seal(&request(NOW)).frame;
        let mut signed = frame[..frame.len() - 64].to_vec();
        let last = signed.len() - 1;
        signed[last] ^= 1;
        assert!(matches!(
            accepted(&mut gateway, &browser.sign(&signed), NOW),
            Err(Error::Undecryptable)
        ));
    }

    #[test]
    fn rejects_frames_for_another_connector() {
        let mut gateway = gateway();
        let elsewhere = Gateway::new(identity(), Uuid::new_v4(), vec![user().verifying_key()]);
        let frame = browser(&elsewhere).seal(&request(NOW)).frame;
        assert!(matches!(
            accepted(&mut gateway, &frame, NOW),
            Err(Error::StaleKey)
        ));
    }

    #[test]
    fn opens_with_the_previous_prekey_until_it_is_rotated_out() {
        let mut gateway = gateway();
        let browser = browser(&gateway);
        gateway.rotate();
        assert!(accepted(&mut gateway, &browser.seal(&request(NOW)).frame, NOW).is_ok());
        gateway.rotate();
        assert!(matches!(
            accepted(&mut gateway, &browser.seal(&request(NOW)).frame, NOW),
            Err(Error::StaleKey)
        ));
    }

    #[test]
    fn rejects_malformed_frames() {
        let mut gateway = gateway();
        let frame = browser(&gateway).seal(&request(NOW)).frame;
        let mut wrong_version = frame.clone();
        wrong_version[0] = 0x03;
        let mut wrong_suite = frame.clone();
        wrong_suite[6] = 0x01;
        for frame in [
            vec![],
            frame[..64].to_vec(),
            frame[..frame.len() - 64 - 16 - 32 - 1].to_vec(),
            wrong_version,
            wrong_suite,
        ] {
            assert!(matches!(
                accepted(&mut gateway, &frame, NOW),
                Err(Error::Malformed)
            ));
        }
        assert!(gateway.seen.is_empty());
    }

    #[test]
    fn opens_fresh_requests_once() {
        let mut gateway = gateway();
        let envelope = request(NOW);
        let sealed = browser(&gateway).seal(&envelope);
        assert_eq!(
            accepted(&mut gateway, &sealed.frame, NOW + Gateway::MAX_AGE_MS).unwrap(),
            envelope
        );
        assert_eq!(refusal(&mut gateway, &sealed.frame, NOW), Refusal::Replayed);
        let resealed = browser(&gateway).seal(&envelope);
        assert_eq!(
            refusal(&mut gateway, &resealed.frame, NOW),
            Refusal::Replayed
        );
    }

    #[test]
    fn refuses_expired_requests_with_a_sealed_clock() {
        let mut gateway = gateway();
        let envelope = request(NOW);
        let sealed = browser(&gateway).seal(&envelope);
        for now in [NOW + 1 + Gateway::MAX_AGE_MS, NOW - 1 - Gateway::MAX_AGE_MS] {
            let Opened {
                responder,
                envelope: refused,
            } = open(&mut gateway, &sealed.frame, now).unwrap();
            assert_eq!(refused.unwrap_err(), Refusal::Expired);
            let answer = sealed.open(&responder.seal(&Refusal::Expired).unwrap());
            assert_eq!(answer.id, envelope.id);
            assert_eq!(answer.body, json!({ "refusal": "expired" }));
            assert!(answer.sent_at > NOW);
        }
        assert!(gateway.seen.is_empty());
    }

    #[test]
    fn signs_each_key_config_with_the_identity() {
        let mut gateway = gateway();
        let first = gateway.key_config().clone();
        gateway.rotate();
        let second = gateway.key_config();
        assert_ne!(first.config, second.config);
        for signed in [&first, second] {
            assert!(
                identity()
                    .verifying_key()
                    .verify_strict(
                        &[b"dbgopher/key-config".as_slice(), &signed.config].concat(),
                        &signed.signature
                    )
                    .is_ok()
            );
        }
    }
}
