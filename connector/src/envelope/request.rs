use ed25519_dalek::{Signature, VerifyingKey};

use super::{Error, SUITE};

pub(super) const VERSION: u8 = 0x04;
const INFO_LABEL: &[u8] = b"dbgopher/request";
pub(super) const SIGNATURE_LABEL: &[u8] = b"dbgopher/request-sig";

pub(super) struct RequestFrame<'a> {
    header: &'a [u8; 1 + SUITE.len() + 32 + 32],
    pub(super) config_hash: &'a [u8; 32],
    pub(super) user_key: &'a [u8; 32],
    pub(super) enc: &'a [u8; 32],
    pub(super) ciphertext: &'a [u8],
    signed: &'a [u8],
    signature: Signature,
}

impl<'a> RequestFrame<'a> {
    pub(super) fn parse(frame: &'a [u8]) -> Result<Self, Error> {
        let (signed, signature) = frame.split_last_chunk().ok_or(Error::Malformed)?;
        let (header, rest) = signed.split_first_chunk().ok_or(Error::Malformed)?;
        let (enc, ciphertext) = rest.split_first_chunk().ok_or(Error::Malformed)?;
        let (&[version], fields) = header.split_first_chunk().ok_or(Error::Malformed)?;
        let (suite, fields) = fields.split_first_chunk().ok_or(Error::Malformed)?;
        if version != VERSION || *suite != SUITE {
            return Err(Error::Malformed);
        }
        let (config_hash, user_key) = fields.split_first_chunk().ok_or(Error::Malformed)?;
        Ok(Self {
            header,
            config_hash,
            user_key: user_key.try_into().map_err(|_| Error::Malformed)?,
            enc,
            ciphertext,
            signed,
            signature: Signature::from_bytes(signature),
        })
    }

    pub(super) fn info(&self) -> Vec<u8> {
        info(self.header)
    }

    pub(super) fn is_signed_by(&self, user: &VerifyingKey) -> bool {
        user.verify_strict(&[SIGNATURE_LABEL, self.signed].concat(), &self.signature)
            .is_ok()
    }
}

pub(super) fn info(header: &[u8]) -> Vec<u8> {
    [INFO_LABEL, &[0], header].concat()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::vectors;

    #[test]
    fn splits_the_vector_frame() {
        let vectors = vectors::load();
        let frame = hex::decode(&vectors.request.frame).unwrap();
        let request = RequestFrame::parse(&frame).unwrap();
        assert_eq!(hex::encode(request.header), vectors.request.header);
        assert_eq!(hex::encode(request.config_hash), vectors.key_config.hash);
        assert_eq!(hex::encode(request.user_key), vectors.user.public);
        assert_eq!(hex::encode(request.enc), vectors.request.enc);
        assert_eq!(
            request.ciphertext.len(),
            frame.len() - request.header.len() - 32 - 64
        );
    }
}
