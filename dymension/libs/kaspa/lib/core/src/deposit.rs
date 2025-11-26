use bytes::Bytes;
use eyre::Result;
use hyperlane_core::{Encode, HyperlaneMessage, U256};
use hyperlane_cosmos_rs::dymensionxyz::hyperlane::kaspa::{
    DepositFxg as ProtoDepositFXG, DepositVersion,
};
use kaspa_rpc_core::RpcHash;
use prost::Message;
use std::str::FromStr;

#[derive(Debug, PartialEq, Clone)]
pub struct DepositFXG {
    pub amount: U256,
    pub tx_id: String,
    pub utxo_index: usize,
    pub accepting_block_hash: String,
    pub hl_message: HyperlaneMessage,
    pub containing_block_hash: String,
}

impl Default for DepositFXG {
    fn default() -> Self {
        Self {
            amount: U256::from(0),
            tx_id: String::new(),
            utxo_index: 0,
            accepting_block_hash: String::new(),
            hl_message: HyperlaneMessage::default(),
            containing_block_hash: String::new(),
        }
    }
}

impl DepositFXG {
    pub fn accepting_block_hash_rpc(&self) -> Result<RpcHash> {
        RpcHash::from_str(&self.accepting_block_hash).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to convert accepting block hash to RpcHash")
        })
    }

    pub fn tx_id_rpc(&self) -> Result<RpcHash> {
        RpcHash::from_str(&self.tx_id)
            .map_err(|e| eyre::Report::new(e).wrap_err("Failed to convert tx hash to RpcHash"))
    }

    pub fn containing_block_hash_rpc(&self) -> Result<RpcHash> {
        RpcHash::from_str(&self.containing_block_hash).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to convert containing block hash to RpcHash")
        })
    }
}

impl TryFrom<Bytes> for DepositFXG {
    type Error = eyre::Report;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        let protodeposit = ProtoDepositFXG::decode(bytes).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to deserialize proto DepositFXG from bytes")
        })?;

        Ok(DepositFXG::from(protodeposit))
    }
}

impl From<&DepositFXG> for Bytes {
    fn from(deposit: &DepositFXG) -> Self {
        let proto_deposit = ProtoDepositFXG::from(deposit);
        Bytes::from(proto_deposit.encode_to_vec())
    }
}

impl From<&DepositFXG> for ProtoDepositFXG {
    fn from(deposit: &DepositFXG) -> Self {
        ProtoDepositFXG {
            version: DepositVersion::DepositVersion1 as i32,
            amount: deposit.amount.to_vec(), // U256 -> Vec<u8>
            tx_id: deposit.tx_id.clone(),
            utxo_index: deposit.utxo_index as u32, // usize -> u32
            accepting_block_hash: deposit.accepting_block_hash.clone(),
            hl_message: deposit.hl_message.to_vec(),
            containing_block_hash: deposit.containing_block_hash.clone(),
        }
    }
}

impl From<ProtoDepositFXG> for DepositFXG {
    fn from(pb_deposit: ProtoDepositFXG) -> Self {
        DepositFXG {
            amount: U256::from_little_endian(&pb_deposit.amount.to_vec()),
            tx_id: pb_deposit.tx_id,
            utxo_index: pb_deposit.utxo_index as usize,
            accepting_block_hash: pb_deposit.accepting_block_hash,
            hl_message: HyperlaneMessage::from(pb_deposit.hl_message),
            containing_block_hash: pb_deposit.containing_block_hash,
        }
    }
}

// --- Test Module ---
#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;
    use eyre::Result as EyreResult;
    use hyperlane_core::H256;
    // --- Test Cases for DepositFXG Conversions ---

    #[tokio::test]
    async fn test_deposit_fxg_serialization_deserialization_roundtrip() {
        // Arrange: Create a sample DepositFXG instance
        let original_deposit = DepositFXG {
            tx_id: "test_transaction_id_123".to_string(),
            utxo_index: 5,
            amount: U256::from(100_000_000),
            accepting_block_hash: "test_block_id_abc".to_string(),
            containing_block_hash: "test_block_id_def".to_string(),
            hl_message: HyperlaneMessage::default(),
        };

        // Act: Serialize to Bytes, then deserialize back
        let encoded_bytes: Bytes = (&original_deposit).into(); // Using the `From<&DepositFXG> for Bytes` impl
        let decoded_deposit: EyreResult<DepositFXG> = DepositFXG::try_from(encoded_bytes.clone()); // Using the `TryFrom<Bytes> for DepositFXG` impl

        // Assert:
        // 1. Deserialization should be successful (Ok)
        assert!(
            decoded_deposit.is_ok(),
            "Deserialization failed: {:?}",
            decoded_deposit.unwrap_err()
        );

        // 2. The deserialized object should be identical to the original
        let unwrapped_decoded_deposit = decoded_deposit.unwrap();
        assert_eq!(
            unwrapped_decoded_deposit, original_deposit,
            "Deserialized object does not match original"
        );
    }

    #[tokio::test]
    async fn test_deposit_fxg_deserialization_from_invalid_bytes_fails() {
        // Arrange: Create some invalid bytes (e.g., truncated data, random garbage)
        let invalid_bytes = Bytes::from(vec![0x01, 0x02, 0x03, 0x04]); // Too short or malformed for bincode

        // Act: Attempt to deserialize from invalid bytes
        let decoded_deposit: EyreResult<DepositFXG> = DepositFXG::try_from(invalid_bytes.clone());

        // Assert: Deserialization should fail (Err)
        assert!(
            decoded_deposit.is_err(),
            "Expected deserialization to fail, but it succeeded"
        );

        // Optionally, check if the error message contains expected text
        let error = decoded_deposit.unwrap_err();
        println!("Received error for invalid bytes: {:?}", error);
        assert!(
            error
                .to_string()
                .contains("Failed to deserialize proto DepositFXG from bytes"),
            "Error message unexpected"
        );
    }

    #[tokio::test]
    async fn test_deposit_fxg_serialization_determinism() {
        // Arrange: Create two identical DepositFXG instances
        let deposit1 = DepositFXG {
            tx_id: "deterministic_tx".to_string(),
            utxo_index: 10,
            containing_block_hash: "deterministic_block".to_string(),
            accepting_block_hash: "deterministic_block".to_string(),
            amount: U256::from(100_000_000),
            hl_message: HyperlaneMessage {
                version: 1,
                nonce: 100,
                origin: 1,
                destination: 2,
                sender: H256([2; 32]),
                recipient: H256([3; 32]),
                body: b"fixed_body".to_vec(),
            },
        };

        let deposit2 = DepositFXG {
            tx_id: "deterministic_tx".to_string(),
            utxo_index: 10,
            containing_block_hash: "deterministic_block".to_string(),
            accepting_block_hash: "deterministic_block".to_string(),
            amount: U256::from(100_000_000),
            hl_message: HyperlaneMessage {
                version: 1,
                nonce: 100,
                origin: 1,
                destination: 2,
                sender: H256([2; 32]),
                recipient: H256([3; 32]),
                body: b"fixed_body".to_vec(),
            },
        };

        // Act: Serialize both
        let encoded_bytes1: Bytes = (&deposit1).into();
        let encoded_bytes2: Bytes = (&deposit2).into();

        // Assert: Encoded bytes should be identical
        assert_eq!(
            encoded_bytes1, encoded_bytes2,
            "Serialization should be deterministic for identical objects"
        );
    }
}
