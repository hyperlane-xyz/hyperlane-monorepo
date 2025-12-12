//! Payload builders for common Hyperlane operations
//!
//! This module provides helper functions to construct `FullPayload` instances
//! for various Hyperlane operations like validator announce.

use chrono::Utc;
use hyperlane_core::{identifiers::UniqueIdentifier, Announcement, SignedType, H256};
use serde::{Deserialize, Serialize};

use super::{FullPayload, PayloadDetails};

/// Transaction data for a validator announce operation.
/// This is serialized and included in the FullPayload.data field.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ValidatorAnnounceTxData {
    /// The signed announcement containing validator address, mailbox info, and storage location
    pub announcement: SignedType<Announcement>,
}

impl ValidatorAnnounceTxData {
    /// Create a new ValidatorAnnounceTxData from a signed announcement
    pub fn new(announcement: SignedType<Announcement>) -> Self {
        Self { announcement }
    }

    /// Serialize the announcement data to bytes for inclusion in FullPayload
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("ValidatorAnnounceTxData serialization should not fail")
    }
}

/// Build a `FullPayload` for a validator announce operation.
///
/// # Arguments
/// * `announcement` - The signed announcement to be submitted
/// * `validator_announce_address` - The address of the ValidatorAnnounce contract
/// * `metadata` - Optional metadata string for logging/debugging (defaults to "validator_announce")
///
/// # Returns
/// A `FullPayload` ready to be submitted to the lander dispatcher
pub fn build_validator_announce_payload(
    announcement: SignedType<Announcement>,
    validator_announce_address: H256,
    metadata: Option<String>,
) -> FullPayload {
    let tx_data = ValidatorAnnounceTxData::new(announcement);
    let payload_data = tx_data.to_bytes();

    let uuid = UniqueIdentifier::new();
    let metadata = metadata.unwrap_or_else(|| "validator_announce".to_string());

    FullPayload {
        details: PayloadDetails {
            uuid,
            metadata,
            success_criteria: None,
        },
        data: payload_data,
        to: validator_announce_address,
        status: super::PayloadStatus::ReadyToSubmit,
        value: None,
        inclusion_soft_deadline: Some(Utc::now()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::{H160, H256};

    fn mock_announcement() -> Announcement {
        Announcement {
            validator: H160::random(),
            mailbox_address: H256::random(),
            mailbox_domain: 1,
            storage_location: "s3://test-bucket/validator".to_string(),
        }
    }

    #[test]
    fn test_validator_announce_tx_data_serialization() {
        let announcement = mock_announcement();
        // Create a mock signed announcement (signature doesn't matter for serialization test)
        let signed = SignedType {
            value: announcement,
            signature: H256::random().into(),
        };

        let tx_data = ValidatorAnnounceTxData::new(signed.clone());
        let bytes = tx_data.to_bytes();

        // Verify we can deserialize
        let deserialized: ValidatorAnnounceTxData =
            serde_json::from_slice(&bytes).expect("Should deserialize");
        assert_eq!(tx_data, deserialized);
    }

    #[test]
    fn test_build_validator_announce_payload() {
        let announcement = mock_announcement();
        let validator_announce_address = H256::random();
        let signed = SignedType {
            value: announcement,
            signature: H256::random().into(),
        };

        let payload = build_validator_announce_payload(
            signed,
            validator_announce_address,
            Some("test_announce".to_string()),
        );

        assert_eq!(payload.to, validator_announce_address);
        assert_eq!(payload.details.metadata, "test_announce");
        assert_eq!(payload.status, super::PayloadStatus::ReadyToSubmit);
        assert!(payload.inclusion_soft_deadline.is_some());
        assert!(payload.data.len() > 0);
    }

    #[test]
    fn test_build_validator_announce_payload_default_metadata() {
        let announcement = mock_announcement();
        let validator_announce_address = H256::random();
        let signed = SignedType {
            value: announcement,
            signature: H256::random().into(),
        };

        let payload = build_validator_announce_payload(signed, validator_announce_address, None);

        assert_eq!(payload.details.metadata, "validator_announce");
    }
}
