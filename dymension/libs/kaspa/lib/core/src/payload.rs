use eyre::Error as EyreError;
use hyperlane_core::H256;
use kaspa_wallet_pskt::pskt::PSKT;
use serde::{Deserialize, Serialize};
use crate::consts::KEY_MESSAGE_IDS;

#[derive(Debug, Serialize, Deserialize)]
pub struct MessageID(pub H256);

#[derive(Debug, Serialize, Deserialize)]
pub struct MessageIDs(pub Vec<MessageID>);

impl MessageIDs {
    pub fn new(ids: Vec<MessageID>) -> Self {
        Self(ids)
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, bincode::Error> {
        bincode::serialize(self)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, bincode::Error> {
        bincode::deserialize(bytes)
    }

    pub fn into_value(self) -> Result<serde_value::Value, serde_value::SerializerError> {
        serde_value::to_value(self)
    }

    pub fn from_value(value: serde_value::Value) -> Result<Self, serde_value::DeserializerError> {
        value.deserialize_into()
    }
}

pub fn message_ids_payload_from_pskt<ROLE>(pskt: &PSKT<ROLE>) -> Result<Vec<u8>, EyreError> {
    if let Some(msg_ids_value) = pskt.global.proprietaries.get(KEY_MESSAGE_IDS) {
        let msg_ids = MessageIDs::from_value(msg_ids_value.clone())
            .map_err(|e| eyre::eyre!("Deserialize MessageIDs: {}", e))?;

        let msg_ids_bytes = msg_ids
            .to_bytes()
            .map_err(|e| eyre::eyre!("Serialize MessageIDs: {}", e))?;

        Ok(msg_ids_bytes)
    } else {
        Ok(vec![]) // Empty payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_ids_serialization_deserialization() {
        let msg_id1 = H256::from([1u8; 32]);
        let msg_id2 = H256::from([2u8; 32]);
        let msg_id3 = H256::from([255u8; 32]);

        let original_ids = vec![msg_id1, msg_id2, msg_id3];
        let message_ids = MessageIDs::new(original_ids.clone());

        // Serialize to serde_value::Value
        let serialized_value = message_ids
            .into_value()
            .expect("Failed to serialize MessageIDs");

        // Deserialize back to MessageIDs
        let deserialized_message_ids =
            MessageIDs::from_value(serialized_value).expect("Failed to deserialize MessageIDs");

        assert_eq!(deserialized_message_ids.0.len(), 3);
        assert_eq!(deserialized_message_ids.0[0], msg_id1);
        assert_eq!(deserialized_message_ids.0[1], msg_id2);
        assert_eq!(deserialized_message_ids.0[2], msg_id3);
        assert_eq!(deserialized_message_ids.0, original_ids);
    }

    #[test]
    fn test_empty_message_ids_serialization() {
        let empty_message_ids = MessageIDs::new(vec![]);

        // Serialize empty vector
        let serialized_value = empty_message_ids
            .into_value()
            .expect("Failed to serialize empty MessageIDs");

        // Deserialize back
        let deserialized_message_ids = MessageIDs::from_value(serialized_value)
            .expect("Failed to deserialize empty MessageIDs");

        assert!(deserialized_message_ids.0.is_empty());
    }

    #[test]
    fn test_single_message_id_serialization() {
        let single_id = vec![H256::from([42u8; 32])];
        let message_ids = MessageIDs::new(single_id.clone());

        // Serialize single item
        let serialized_value = message_ids
            .into_value()
            .expect("Failed to serialize single MessageID");

        // Deserialize back
        let deserialized_message_ids = MessageIDs::from_value(serialized_value)
            .expect("Failed to deserialize single MessageID");

        assert_eq!(deserialized_message_ids.0.len(), 1);
        assert_eq!(deserialized_message_ids.0[0], H256::from([42u8; 32]));
        assert_eq!(deserialized_message_ids.0, single_id);
    }

    #[test]
    fn test_message_ids_bincode_serialization() {
        let msg_id1 = H256::from([1u8; 32]);
        let msg_id2 = H256::from([2u8; 32]);
        let msg_id3 = H256::from([255u8; 32]);

        let original_ids = vec![msg_id1, msg_id2, msg_id3];
        let message_ids = MessageIDs::new(original_ids.clone());

        // Serialize to bytes using bincode
        let serialized_bytes = message_ids
            .to_bytes()
            .expect("Failed to serialize MessageIDs to bytes");

        // Deserialize back from bytes
        let deserialized_message_ids = MessageIDs::from_bytes(&serialized_bytes)
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
        let serialized_bytes = empty_message_ids
            .to_bytes()
            .expect("Failed to serialize empty MessageIDs to bytes");

        // Deserialize back from bytes
        let deserialized_message_ids = MessageIDs::from_bytes(&serialized_bytes)
            .expect("Failed to deserialize empty MessageIDs from bytes");

        assert!(deserialized_message_ids.0.is_empty());
    }

    #[test]
    fn test_single_message_id_bincode_serialization() {
        let single_id = vec![H256::from([42u8; 32])];
        let message_ids = MessageIDs::new(single_id.clone());

        // Serialize single item to bytes
        let serialized_bytes = message_ids
            .to_bytes()
            .expect("Failed to serialize single MessageID to bytes");

        // Deserialize back from bytes
        let deserialized_message_ids = MessageIDs::from_bytes(&serialized_bytes)
            .expect("Failed to deserialize single MessageID from bytes");

        assert_eq!(deserialized_message_ids.0.len(), 1);
        assert_eq!(deserialized_message_ids.0[0], H256::from([42u8; 32]));
        assert_eq!(deserialized_message_ids.0, single_id);
    }

    #[test]
    fn test_bincode_vs_serde_value_consistency() {
        // Test that both serialization methods work consistently
        let msg_ids = vec![
            H256::from([10u8; 32]),
            H256::from([20u8; 32]),
            H256::from([30u8; 32]),
        ];

        let message_ids_1 = MessageIDs::new(msg_ids.clone());
        let message_ids_2 = MessageIDs::new(msg_ids.clone());

        // Test bincode round trip
        let bytes = message_ids_1
            .to_bytes()
            .expect("Failed to serialize to bytes");
        let from_bytes = MessageIDs::from_bytes(&bytes).expect("Failed to deserialize from bytes");

        // Test serde_value round trip
        let serde_value = message_ids_2
            .into_value()
            .expect("Failed to serialize to serde_value");
        let from_serde_value =
            MessageIDs::from_value(serde_value).expect("Failed to deserialize from serde_value");

        // Both should produce the same result
        assert_eq!(from_bytes.0, from_serde_value.0);
        assert_eq!(from_bytes.0, msg_ids);
        assert_eq!(from_serde_value.0, msg_ids);
    }

    #[test]
    fn test_bincode_serialization_deterministic() {
        // Test that serialization is deterministic (same input -> same output)
        let msg_ids = vec![H256::from([123u8; 32]), H256::from([234u8; 32])];

        let message_ids_1 = MessageIDs::new(msg_ids.clone());
        let message_ids_2 = MessageIDs::new(msg_ids);

        let bytes1 = message_ids_1
            .to_bytes()
            .expect("Failed to serialize first instance");
        let bytes2 = message_ids_2
            .to_bytes()
            .expect("Failed to serialize second instance");

        assert_eq!(bytes1, bytes2, "Serialization should be deterministic");
    }
}
