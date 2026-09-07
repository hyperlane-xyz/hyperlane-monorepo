use std::fmt::{Debug, Display, Formatter};

use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};

use crate::{
    utils::{fmt_address_for_domain, fmt_domain},
    Decode, Encode, HyperlaneProtocolError, H256,
};

const HYPERLANE_MESSAGE_PREFIX_LEN: usize = 77;

/// A message ID that has been delivered to the destination
pub type Delivery = H256;

/// A Stamped message that has been committed at some nonce
pub type RawHyperlaneMessage = Vec<u8>;

impl From<&HyperlaneMessage> for RawHyperlaneMessage {
    fn from(m: &HyperlaneMessage) -> Self {
        let mut message_vec = vec![];
        m.write_to(&mut message_vec).expect("!write_to");
        message_vec
    }
}

/// A full Hyperlane message between chains
#[derive(Clone, Eq, PartialEq, Hash, Deserialize, Serialize)]
pub struct HyperlaneMessage {
    /// 1   Hyperlane version number
    pub version: u8,
    /// 4   Message nonce
    pub nonce: u32,
    /// 4   Origin domain ID
    pub origin: u32,
    /// 32  Address in origin convention
    pub sender: H256,
    /// 4   Destination domain ID
    pub destination: u32,
    /// 32  Address in destination convention
    pub recipient: H256,
    /// 0+  Message contents
    pub body: Vec<u8>,
}

impl Default for HyperlaneMessage {
    fn default() -> Self {
        Self {
            // Use version 3 now that Hyperlane V3 is the default
            version: 3,
            nonce: 0,
            origin: 0,
            sender: H256::zero(),
            destination: 0,
            recipient: H256::zero(),
            body: vec![],
        }
    }
}

impl Debug for HyperlaneMessage {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "HyperlaneMessage {{ id: {:?}, nonce: {}, origin: {}, sender: {}, destination: {}, recipient: {} }}",
            self.id(),
            self.nonce,
            fmt_domain(self.origin),
            fmt_address_for_domain(self.origin, self.sender),
            fmt_domain(self.destination),
            fmt_address_for_domain(self.destination, self.recipient),
        )
    }
}

impl Display for HyperlaneMessage {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        Debug::fmt(self, f)
    }
}

impl From<RawHyperlaneMessage> for HyperlaneMessage {
    fn from(m: RawHyperlaneMessage) -> Self {
        HyperlaneMessage::from(&m)
    }
}

impl From<&RawHyperlaneMessage> for HyperlaneMessage {
    fn from(m: &RawHyperlaneMessage) -> Self {
        let version = m[0];
        let nonce: [u8; 4] = m[1..5].try_into().expect("Failed to parse nonce");
        let origin: [u8; 4] = m[5..9].try_into().expect("Failed to parse origin");
        let sender: [u8; 32] = m[9..41].try_into().expect("Failed to parse sender");
        let destination: [u8; 4] = m[41..45].try_into().expect("Failed to parse destination");
        let recipient: [u8; 32] = m[45..77].try_into().expect("Failed to parse recipient");
        let body = m[77..].into();
        Self {
            version,
            nonce: u32::from_be_bytes(nonce),
            origin: u32::from_be_bytes(origin),
            sender: H256::from(sender),
            destination: u32::from_be_bytes(destination),
            recipient: H256::from(recipient),
            body,
        }
    }
}

impl Encode for HyperlaneMessage {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: std::io::Write,
    {
        writer.write_all(&self.version.to_be_bytes())?;
        writer.write_all(&self.nonce.to_be_bytes())?;
        writer.write_all(&self.origin.to_be_bytes())?;
        writer.write_all(self.sender.as_ref())?;
        writer.write_all(&self.destination.to_be_bytes())?;
        writer.write_all(self.recipient.as_ref())?;
        writer.write_all(&self.body)?;
        Ok(HYPERLANE_MESSAGE_PREFIX_LEN.saturating_add(self.body.len()))
    }
}

impl Decode for HyperlaneMessage {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: std::io::Read,
    {
        let mut version = [0u8; 1];
        reader.read_exact(&mut version)?;

        let mut nonce = [0u8; 4];
        reader.read_exact(&mut nonce)?;

        let mut origin = [0u8; 4];
        reader.read_exact(&mut origin)?;

        let mut sender = H256::zero();
        reader.read_exact(sender.as_mut())?;

        let mut destination = [0u8; 4];
        reader.read_exact(&mut destination)?;

        let mut recipient = H256::zero();
        reader.read_exact(recipient.as_mut())?;

        let mut body = vec![];
        reader.read_to_end(&mut body)?;

        Ok(Self {
            version: u8::from_be_bytes(version),
            nonce: u32::from_be_bytes(nonce),
            origin: u32::from_be_bytes(origin),
            sender,
            destination: u32::from_be_bytes(destination),
            recipient,
            body,
        })
    }
}

impl HyperlaneMessage {
    /// Convert the message to a message id
    pub fn id(&self) -> H256 {
        let mut hasher = Keccak256::new();
        // The digest writer consumes the canonical encoding without allocating
        // an intermediate message buffer. Its writes are infallible.
        self.write_to(&mut hasher)
            .expect("Writing to Keccak256 cannot fail");
        H256::from_slice(hasher.finalize().as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::{HyperlaneMessage, RawHyperlaneMessage, HYPERLANE_MESSAGE_PREFIX_LEN};
    use crate::{Decode, Encode, H256};
    use sha3::{Digest, Keccak256};

    #[test]
    fn id_matches_known_message_vector() {
        // Existing vectors/message.json fixture, with its independently specified ID.
        let mut sender = [0; 32];
        sender[12..].fill(0x11);
        let mut recipient = [0; 32];
        recipient[12..].fill(0x22);
        let message = HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1000,
            sender: sender.into(),
            destination: 2000,
            recipient: recipient.into(),
            body: vec![0x12, 0x34],
        };
        let expected = H256::from([
            0xf8, 0xa6, 0x6f, 0x8a, 0xad, 0xee, 0x75, 0x1d, 0x84, 0x26, 0x16, 0xfe, 0xe0, 0xed,
            0x14, 0xa3, 0xad, 0x6d, 0xa1, 0xe1, 0x35, 0x64, 0x92, 0x03, 0x64, 0xee, 0x0a, 0xd3,
            0x5a, 0x02, 0x70, 0x3f,
        ]);
        assert_eq!(message.id(), expected);
    }

    #[test]
    fn streamed_id_matches_canonical_encoding_at_hash_block_boundaries() {
        for length in [0, 1, 58, 59, 60, 135, 136, 137, 271, 272, 4096, 65536] {
            for version in [0, 3, u8::MAX] {
                for nonce in [0, 1, u32::MAX] {
                    let message = HyperlaneMessage {
                        version,
                        nonce,
                        origin: nonce.rotate_left(7),
                        sender: H256::repeat_byte(version),
                        destination: nonce ^ 0xa5a5_a5a5,
                        recipient: H256::repeat_byte(!version),
                        body: (0..length).map(|i| (i % 256) as u8).collect(),
                    };
                    let encoded = message.to_vec();
                    assert_eq!(encoded.len(), HYPERLANE_MESSAGE_PREFIX_LEN + length);
                    let expected = H256::from_slice(Keccak256::digest(&encoded).as_slice());
                    assert_eq!(message.id(), expected);
                }
            }
        }
    }

    fn sample_message() -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce: 42,
            origin: 1,
            sender: H256::repeat_byte(0x11),
            destination: 2,
            recipient: H256::repeat_byte(0x22),
            body: b"payload".to_vec(),
        }
    }

    fn valid_message_bytes() -> RawHyperlaneMessage {
        RawHyperlaneMessage::from(&sample_message())
    }

    #[test]
    fn read_from_valid_input_unchanged() {
        let expected = sample_message();
        let bytes = valid_message_bytes();
        assert!(bytes.len() > HYPERLANE_MESSAGE_PREFIX_LEN);

        let decoded = HyperlaneMessage::read_from(&mut bytes.as_slice()).expect("valid message");
        assert_eq!(decoded, expected);
        assert_eq!(HyperlaneMessage::from(bytes), decoded);
    }

    #[test]
    fn read_from_empty_input_returns_err() {
        let mut empty: &[u8] = &[];
        assert!(HyperlaneMessage::read_from(&mut empty).is_err());
    }

    #[test]
    fn read_from_truncated_input_returns_err() {
        let bytes = valid_message_bytes();
        for len in [1usize, 40, HYPERLANE_MESSAGE_PREFIX_LEN - 1] {
            let mut truncated = &bytes[..len];
            assert!(
                HyperlaneMessage::read_from(&mut truncated).is_err(),
                "expected Err for truncated len={len}"
            );
        }
    }

    #[test]
    fn read_from_malformed_short_input_returns_err() {
        let mut malformed: &[u8] = &[0u8; 50];
        assert!(HyperlaneMessage::read_from(&mut malformed).is_err());
    }

    #[ignore]
    #[test]
    fn test_decode_from_raw_body() {
        let raw = "0x03000005C50000044D0000000000000000000000007DAC480D20F322D2EF108A59A465CCB5749371C40000A86A0000000000000000000000007DAC480D20F322D2EF108A59A465CCB5749371C40000000000000000000000007566176716A55DAD1B4E83D0E2273FB95049483E0000000000000000000000000000000000000000000000000000000008F0D3EC";

        let raw_bytes = hex::decode(&raw[2..]).unwrap();
        let msg = HyperlaneMessage::from(raw_bytes);

        eprintln!(
            r#"Message ID: {:x}
Message Version: {}
Message: {}
Message Body: {:?}"#,
            msg.id(),
            msg.version,
            msg,
            msg.body
        );
    }
}
