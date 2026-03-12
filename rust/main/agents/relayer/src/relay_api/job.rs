use hyperlane_core::H256;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayJob {
    pub id: Uuid,
    pub origin_chain: String,
    pub origin_tx_hash: String, // Protocol-agnostic: hex for EVM, base58 for Sealevel, etc.
    pub message_id: H256,
    pub destination_chain: String,
    pub status: RelayStatus,
    pub destination_tx_hash: Option<String>, // Protocol-agnostic tx hash
    pub error: Option<String>,
    pub created_at: u64, // Unix timestamp (seconds)
    pub updated_at: u64,
    pub expires_at: u64, // TTL: 1 hour
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RelayStatus {
    Pending,    // Job created, not started
    Extracting, // Fetching tx receipt
    Preparing,  // MessageProcessor preparing (building ISM metadata)
    Submitting, // Submitting to destination
    Submitted,  // Tx submitted, waiting confirmation
    Confirmed,  // Tx confirmed on destination
    Failed,     // Error occurred
}

impl RelayJob {
    pub fn new(origin_chain: String, origin_tx_hash: String) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        Self {
            id: Uuid::new_v4(),
            origin_chain,
            origin_tx_hash,
            message_id: H256::zero(), // Will be filled after extraction
            destination_chain: String::new(), // Will be filled after extraction
            status: RelayStatus::Pending,
            destination_tx_hash: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: now + 3600, // 1 hour TTL
        }
    }

    pub fn update_status(&mut self, status: RelayStatus) {
        self.status = status;
        self.updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
    }

    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
        self.update_status(RelayStatus::Failed);
    }

    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        now > self.expires_at
    }
}
