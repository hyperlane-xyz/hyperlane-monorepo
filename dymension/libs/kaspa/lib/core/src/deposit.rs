use super::escrow::*;

use bytes::Bytes;

use std::sync::Arc;

use kaspa_wallet_core::error::Error;
use kaspa_wallet_core::tx::Fees;

use kaspa_addresses::Prefix;

use kaspa_wallet_core::prelude::*;

use workflow_core::abortable::Abortable;

use hyperlane_core::HyperlaneMessage;
use hyperlane_core::H256;
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct DepositFXG {
    pub msg_id: H256,
    pub tx_id: String,
    pub utxo_index: usize,
    pub block_id: String,
    pub payload: HyperlaneMessage,
}

impl TryFrom<Bytes> for DepositFXG {
    type Error = eyre::Report;

    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        // Deserialize the bytes into DepositFXG using bincode
        bincode::deserialize(&bytes).map_err(|e| {
            eyre::Report::new(e).wrap_err("Failed to deserialize DepositFXG from bytes")
        })
    }
}

impl From<&DepositFXG> for Bytes {
    fn from(deposit: &DepositFXG) -> Self {
        // Serialize the DepositFXG into bytes using bincode
        let encoded: Vec<u8> =
            bincode::serialize(deposit).expect("Failed to serialize DepositFXG into bytes");
        Bytes::from(encoded)
    }
}

pub async fn deposit(
    w: &Arc<Wallet>,
    secret: &Secret,
    e: &Escrow,
    amt: u64,
    prefix: Prefix,
) -> Result<TransactionId, Error> {
    let a = w.account()?;

    let dst = PaymentDestination::from(PaymentOutput::new(e.public(prefix).addr, amt));
    let fees = Fees::from(0i64);
    let payload = None;
    let payment_secret = None;
    let abortable = Abortable::new();

    // use account.send, because wallet.accounts_send(AccountsSendRequest{..}) is buggy
    let (summary, _) = a
        .send(
            dst,
            fees,
            payload,
            secret.clone(),
            payment_secret,
            &abortable,
            None,
        )
        .await?;

    summary.final_transaction_id().ok_or_else(|| {
        Error::Custom("Deposit transaction failed to generate a transaction ID".to_string())
    })
}


// --- Test Module ---
#[cfg(test)]
mod tests {
    use super::*; // Import `DepositFXG`, `H256`, `HyperlaneMessage` etc.
    use bytes::Bytes;
    // Use `StdResult` and `EyreResult` as defined in your main file
    use std::result::Result as StdResult;
    use eyre::Result as EyreResult;


    // --- Test Cases for DepositFXG Conversions ---

    #[tokio::test] // Using tokio::test as it's already in your dev-dependencies
    async fn test_deposit_fxg_serialization_deserialization_roundtrip() {
        // Arrange: Create a sample DepositFXG instance
        let original_deposit = DepositFXG {
            msg_id: H256::random(),
            tx_id: "test_transaction_id_123".to_string(),
            utxo_index: 5,
            block_id: "test_block_id_abc".to_string(),
            payload: HyperlaneMessage::default(),
        };

        // Act: Serialize to Bytes, then deserialize back
        let encoded_bytes: Bytes = (&original_deposit).into(); // Using the `From<&DepositFXG> for Bytes` impl
        let decoded_deposit: EyreResult<DepositFXG> = DepositFXG::try_from(encoded_bytes.clone()); // Using the `TryFrom<Bytes> for DepositFXG` impl

        // Assert:
        // 1. Deserialization should be successful (Ok)
        assert!(decoded_deposit.is_ok(), "Deserialization failed: {:?}", decoded_deposit.unwrap_err());

        // 2. The deserialized object should be identical to the original
        let unwrapped_decoded_deposit = decoded_deposit.unwrap();
        assert_eq!(unwrapped_decoded_deposit, original_deposit, "Deserialized object does not match original");
    }

    #[tokio::test]
    async fn test_deposit_fxg_deserialization_from_invalid_bytes_fails() {
        // Arrange: Create some invalid bytes (e.g., truncated data, random garbage)
        let invalid_bytes = Bytes::from(vec![0x01, 0x02, 0x03, 0x04]); // Too short or malformed for bincode

        // Act: Attempt to deserialize from invalid bytes
        let decoded_deposit: EyreResult<DepositFXG> = DepositFXG::try_from(invalid_bytes.clone());

        // Assert: Deserialization should fail (Err)
        assert!(decoded_deposit.is_err(), "Expected deserialization to fail, but it succeeded");

        // Optionally, check if the error message contains expected text
        let error = decoded_deposit.unwrap_err();
        println!("Received error for invalid bytes: {:?}", error);
        assert!(error.to_string().contains("Failed to deserialize DepositFXG from bytes"), "Error message unexpected");
    }

    #[tokio::test]
    async fn test_deposit_fxg_serialization_determinism() {
        // Arrange: Create two identical DepositFXG instances
        let deposit1 = DepositFXG {
            msg_id: H256([1; 32]),
            tx_id: "deterministic_tx".to_string(),
            utxo_index: 10,
            block_id: "deterministic_block".to_string(),
            payload: HyperlaneMessage {
                version: 1, 
                nonce: 100, 
                origin: 1, 
                destination: 2,
                sender: H256([2; 32]), recipient: H256([3; 32]),
                body: b"fixed_body".to_vec(),
            },
        };

        let deposit2 = DepositFXG {
            msg_id: H256([1; 32]),
            tx_id: "deterministic_tx".to_string(),
            utxo_index: 10,
            block_id: "deterministic_block".to_string(),
            payload: HyperlaneMessage {
                version: 1, 
                nonce: 100, 
                origin: 1, 
                destination: 2,
                sender: H256([2; 32]), recipient: H256([3; 32]),
                body: b"fixed_body".to_vec(),
            },
        };

        // Act: Serialize both
        let encoded_bytes1: Bytes = (&deposit1).into();
        let encoded_bytes2: Bytes = (&deposit2).into();

        // Assert: Encoded bytes should be identical
        assert_eq!(encoded_bytes1, encoded_bytes2, "Serialization should be deterministic for identical objects");
    }


}