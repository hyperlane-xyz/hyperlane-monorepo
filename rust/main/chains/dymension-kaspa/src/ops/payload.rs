use bytes::Bytes;
use eyre::Error as EyreError;
use hyperlane_core::{Encode, HyperlaneMessage, H256};
use hyperlane_cosmos_rs::dymensionxyz::hyperlane::kaspa::MessageIDs as ProtoMessageIDs;
use hyperlane_cosmos_rs::prost::Message;

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub struct MessageID(pub H256);

#[derive(Debug)]
pub struct MessageIDs(pub Vec<MessageID>);

impl MessageIDs {
    pub fn new(ids: Vec<MessageID>) -> Self {
        Self(ids)
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        Bytes::from(self).to_vec()
    }

    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self, EyreError> {
        Self::try_from(Bytes::from(bytes))
    }

    // Parse the payload string to extract the message ID
    pub fn from_tx_payload(payload: &str) -> Result<Self, eyre::Error> {
        let unhexed_payload =
            hex::decode(payload).map_err(|e| eyre::eyre!("Failed to decode payload: {}", e))?;
        Self::try_from(Bytes::from(unhexed_payload))
    }
}

impl TryFrom<Bytes> for MessageIDs {
    type Error = EyreError;

    fn try_from(v: Bytes) -> Result<Self, Self::Error> {
        let p =
            ProtoMessageIDs::decode(v).map_err(|e| eyre::eyre!("MessageIDs deserialize: {}", e))?;
        Ok(MessageIDs::from(p))
    }
}

impl From<&MessageIDs> for Bytes {
    fn from(v: &MessageIDs) -> Self {
        let p = ProtoMessageIDs::from(v);
        Bytes::from(p.encode_to_vec())
    }
}

impl TryFrom<Vec<u8>> for MessageIDs {
    type Error = EyreError;

    fn try_from(v: Vec<u8>) -> Result<Self, Self::Error> {
        Self::try_from(Bytes::from(v))
    }
}

impl From<&MessageIDs> for Vec<u8> {
    fn from(v: &MessageIDs) -> Self {
        Bytes::from(v).to_vec()
    }
}

impl From<ProtoMessageIDs> for MessageIDs {
    fn from(v: ProtoMessageIDs) -> Self {
        Self(
            v.message_ids
                .iter()
                .map(|m| MessageID(H256::from_slice(m)))
                .collect(),
        )
    }
}

impl From<&MessageIDs> for ProtoMessageIDs {
    fn from(v: &MessageIDs) -> Self {
        ProtoMessageIDs {
            message_ids: v.0.iter().map(|id| id.0.to_vec()).collect(),
        }
    }
}

impl From<Vec<H256>> for MessageIDs {
    fn from(v: Vec<H256>) -> Self {
        MessageIDs(v.into_iter().map(MessageID).collect())
    }
}

impl From<Vec<HyperlaneMessage>> for MessageIDs {
    fn from(m: Vec<HyperlaneMessage>) -> Self {
        MessageIDs(m.into_iter().map(|w| MessageID(w.id())).collect())
    }
}

impl From<&Vec<HyperlaneMessage>> for MessageIDs {
    fn from(m: &Vec<HyperlaneMessage>) -> Self {
        MessageIDs(m.iter().map(|w| MessageID(w.id())).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_ids_bincode_serialization() {
        let msg_id1 = MessageID(H256::from([1u8; 32]));
        let msg_id2 = MessageID(H256::from([2u8; 32]));
        let msg_id3 = MessageID(H256::from([255u8; 32]));

        let original_ids = vec![msg_id1, msg_id2, msg_id3];
        let message_ids = MessageIDs::new(original_ids.clone());

        // Serialize to bytes using bincode
        let serialized_bytes = message_ids.to_bytes();

        // Deserialize back from bytes
        let deserialized_message_ids = MessageIDs::try_from(serialized_bytes)
            .expect("Failed to deserialize MessageIDs from bytes");

        assert_eq!(deserialized_message_ids.0.len(), 3);
        assert_eq!(deserialized_message_ids.0[0], msg_id1);
        assert_eq!(deserialized_message_ids.0[1], msg_id2);
        assert_eq!(deserialized_message_ids.0[2], msg_id3);
        assert_eq!(deserialized_message_ids.0, original_ids);
    }

    #[test]
    fn test_empty_message_ids_bincode_serialization() {
        let empty_message_ids = MessageIDs::new(vec![]);

        // Serialize empty vector to bytes
        let serialized_bytes = empty_message_ids.to_bytes();

        // Deserialize back from bytes
        let deserialized_message_ids = MessageIDs::try_from(serialized_bytes)
            .expect("Failed to deserialize empty MessageIDs from bytes");

        assert!(deserialized_message_ids.0.is_empty());
    }

    #[test]
    fn test_single_message_id_bincode_serialization() {
        let single_id = vec![MessageID(H256::from([42u8; 32]))];
        let message_ids = MessageIDs::new(single_id.clone());

        // Serialize single item to bytes
        let serialized_bytes = message_ids.to_bytes();

        // Deserialize back from bytes
        let deserialized_message_ids = MessageIDs::try_from(serialized_bytes)
            .expect("Failed to deserialize single MessageID from bytes");

        assert_eq!(deserialized_message_ids.0.len(), 1);
        assert_eq!(
            deserialized_message_ids.0[0],
            MessageID(H256::from([42u8; 32]))
        );
        assert_eq!(deserialized_message_ids.0, single_id);
    }

    #[test]
    fn test_bincode_serialization_deterministic() {
        // Test that serialization is deterministic (same input -> same output)
        let msg_ids = vec![
            MessageID(H256::from([123u8; 32])),
            MessageID(H256::from([234u8; 32])),
        ];

        let message_ids_1 = MessageIDs::new(msg_ids.clone());
        let message_ids_2 = MessageIDs::new(msg_ids);

        let bytes1 = message_ids_1.to_bytes();
        let bytes2 = message_ids_2.to_bytes();

        assert_eq!(bytes1, bytes2, "Serialization should be deterministic");
    }
}
