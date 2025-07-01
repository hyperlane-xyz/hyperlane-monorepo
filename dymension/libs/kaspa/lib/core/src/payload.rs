use crate::consts::KEY_MESSAGE_IDS;
use eyre::Error as EyreError;
use hyperlane_core::H256;
use kaspa_wallet_pskt::pskt::PSKT;
use serde::{Deserialize, Serialize};

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
