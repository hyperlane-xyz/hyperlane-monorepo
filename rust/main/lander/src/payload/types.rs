// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::fmt::Debug;

use chrono::{DateTime, Utc};

use hyperlane_core::{identifiers::UniqueIdentifier, H256, U256};

use crate::transaction::TransactionStatus;

pub type PayloadUuid = UniqueIdentifier;
type Address = H256;

/// Struct needed to keep lightweight references to payloads, such that when included in logs there's no noise.
#[derive(Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub struct PayloadDetails {
    /// unique payload identifier
    pub uuid: PayloadUuid,

    /// to be printed in logs for easier debugging. This may include the Hyperlane Message ID
    pub metadata: String,

    // unused field in MVP
    /// view calls for checking if batch subcalls reverted. EVM-specific for now.
    pub success_criteria: Option<Vec<u8>>,
}

impl Debug for PayloadDetails {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PayloadDetails")
            .field("uuid", &self.uuid)
            .field("metadata", &self.metadata)
            .finish()
    }
}

impl PayloadDetails {
    pub fn new(
        uuid: PayloadUuid,
        metadata: impl Into<String>,
        success_criteria: Option<Vec<u8>>,
    ) -> Self {
        Self {
            uuid,
            metadata: metadata.into(),
            success_criteria,
        }
    }
}

/// Full details about a payload. This is instantiated by the caller of PayloadDispatcher
#[derive(Clone, Default, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct FullPayload {
    /// reference to payload used by other components
    pub details: PayloadDetails,
    /// serialized `ContractCall` on EVM. On SVM, it is the serialized instructions and account list. On Cosmos, it is the serialized vec of msgs
    pub data: Vec<u8>,
    /// defaults to the hyperlane mailbox
    pub to: Address,
    /// defaults to `ReadyToSubmit`
    pub status: PayloadStatus,

    // unused fields in MVP
    // always None initially
    pub value: Option<U256>,
    /// will be up to the adapter to interpret this. Meant to help enforce the new igp social contract requirement (after 30 mins, stop enforcing any gas price caps)
    pub inclusion_soft_deadline: Option<DateTime<Utc>>,
}

impl Debug for FullPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FullPayload")
            .field("uuid", &self.details.uuid)
            .field("metadata", &self.details.metadata)
            .field("to", &self.to)
            .field("status", &self.status)
            .field("value", &self.value)
            .field("inclusion_soft_deadline", &self.inclusion_soft_deadline)
            .finish()
    }
}

impl FullPayload {
    pub fn new(
        uuid: PayloadUuid,
        metadata: impl Into<String>,
        data: Vec<u8>,
        success_criteria: Option<Vec<u8>>,
        to: Address,
    ) -> Self {
        Self {
            details: PayloadDetails::new(uuid, metadata, success_criteria),
            data,
            to,
            status: Default::default(),
            value: None,
            inclusion_soft_deadline: None,
        }
    }

    pub fn uuid(&self) -> &PayloadUuid {
        &self.details.uuid
    }

    #[cfg(test)]
    pub fn random() -> Self {
        let payload_uuid = PayloadUuid::random();
        let details = PayloadDetails {
            uuid: payload_uuid.clone(),
            metadata: format!("payload-{}", payload_uuid.to_string()),
            success_criteria: None,
        };
        FullPayload {
            details,
            data: vec![],
            to: Address::zero(),
            status: PayloadStatus::default(),
            value: None,
            inclusion_soft_deadline: None,
        }
    }
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub enum PayloadStatus {
    #[default]
    ReadyToSubmit,
    InTransaction(TransactionStatus),
    Dropped(DropReason),
    Retry(RetryReason),
}

impl PayloadStatus {
    pub fn is_finalized(&self) -> bool {
        matches!(
            self,
            PayloadStatus::InTransaction(TransactionStatus::Finalized)
        )
    }
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum DropReason {
    FailedToBuildAsTransaction,
    FailedSimulation,
    Reverted,
    UnhandledError,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum RetryReason {
    Reorged,
}
