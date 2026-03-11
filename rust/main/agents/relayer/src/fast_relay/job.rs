use std::time::{SystemTime, UNIX_EPOCH};

use hyperlane_core::H256;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Status of a fast relay job
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RelayStatus {
    /// Job created, not started yet
    Pending,
    /// Building ISM metadata
    Preparing,
    /// Submitting transaction to destination
    Submitting,
    /// Transaction submitted, waiting for confirmation
    Submitted,
    /// Transaction confirmed on destination chain
    Confirmed,
    /// Job failed with error
    Failed,
}

/// A fast relay job tracks the status of an immediately-triggered message relay
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FastRelayJob {
    /// Unique job identifier
    pub id: Uuid,
    /// Origin chain name
    pub origin_chain: String,
    /// Origin transaction hash
    pub origin_tx_hash: H256,
    /// Hyperlane message ID
    pub message_id: H256,
    /// Current status of the relay
    pub status: RelayStatus,
    /// Destination transaction hash (if submitted)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destination_tx_hash: Option<H256>,
    /// Error message (if failed)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Job creation timestamp (seconds since epoch)
    pub created_at: u64,
    /// Job last update timestamp (seconds since epoch)
    pub updated_at: u64,
    /// Job expiration timestamp (seconds since epoch)
    pub expires_at: u64,
}

impl FastRelayJob {
    /// Create a new fast relay job
    pub fn new(
        origin_chain: String,
        origin_tx_hash: H256,
        message_id: H256,
        ttl_seconds: u64,
    ) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs();

        Self {
            id: Uuid::new_v4(),
            origin_chain,
            origin_tx_hash,
            message_id,
            status: RelayStatus::Pending,
            destination_tx_hash: None,
            error: None,
            created_at: now,
            updated_at: now,
            expires_at: now + ttl_seconds,
        }
    }

    /// Update job status
    pub fn update_status(&mut self, status: RelayStatus) {
        self.status = status;
        self.updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs();
    }

    /// Set destination transaction hash
    pub fn set_destination_tx(&mut self, tx_hash: H256) {
        self.destination_tx_hash = Some(tx_hash);
        self.updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs();
    }

    /// Set error message and update status to Failed
    pub fn set_error(&mut self, error: String) {
        self.error = Some(error);
        self.status = RelayStatus::Failed;
        self.updated_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs();
    }

    /// Check if job has expired
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs();
        now > self.expires_at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_job() {
        let job = FastRelayJob::new("ethereum".to_string(), H256::zero(), H256::zero(), 3600);

        assert_eq!(job.status, RelayStatus::Pending);
        assert_eq!(job.origin_chain, "ethereum");
        assert!(job.error.is_none());
        assert!(job.destination_tx_hash.is_none());
    }

    #[test]
    fn test_update_status() {
        let mut job = FastRelayJob::new("ethereum".to_string(), H256::zero(), H256::zero(), 3600);

        let initial_time = job.updated_at;
        std::thread::sleep(std::time::Duration::from_millis(10));

        job.update_status(RelayStatus::Preparing);
        assert_eq!(job.status, RelayStatus::Preparing);
        assert!(job.updated_at > initial_time);
    }

    #[test]
    fn test_set_error() {
        let mut job = FastRelayJob::new("ethereum".to_string(), H256::zero(), H256::zero(), 3600);

        job.set_error("Test error".to_string());
        assert_eq!(job.status, RelayStatus::Failed);
        assert_eq!(job.error, Some("Test error".to_string()));
    }

    #[test]
    fn test_expiration() {
        let job = FastRelayJob::new(
            "ethereum".to_string(),
            H256::zero(),
            H256::zero(),
            0, // Already expired
        );

        assert!(job.is_expired());
    }
}
