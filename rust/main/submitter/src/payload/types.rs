// TODO: re-enable clippy warnings
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use std::ops::Deref;
use uuid::Uuid;

use hyperlane_core::{identifiers::UniqueIdentifier, H256, U256};

pub type PayloadId = UniqueIdentifier;
type Address = H256;

/// Struct needed to keep lightweight references to payloads, such that when included in logs there's no noise.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub struct PayloadDetails {
    /// unique payload identifier
    id: PayloadId,

    /// to be printed in logs for easier debugging. This may include the Hyperlane Message ID
    metadata: String,

    // unused field in MVP
    /// view calls for checking if batch subcalls reverted. EVM-specific for now.
    success_criteria: Option<(Vec<u8>, Address)>,
}

/// Full details about a payload. This is instantiated by the caller of PayloadDispatcher
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub struct FullPayload {
    /// reference to payload used by other components
    details: PayloadDetails,
    /// calldata on EVM. On SVM, it is the serialized instructions and account list. On Cosmos, it is the serialized vec of msgs
    data: Vec<u8>,
    /// defaults to the hyperlane mailbox
    to: Address,
    /// defaults to `ReadyToSubmit`
    status: PayloadStatus,

    // unused fields in MVP
    // always None initially
    value: Option<U256>,
    /// will be up to the adapter to interpret this. Meant to help enforce the new igp social contract requirement (after 30 mins, stop enforcing any gas price caps)
    inclusion_soft_deadline: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub enum PayloadStatus {
    #[default]
    ReadyToSubmit,
    PendingInclusion,
    Included,
    Finalized,
    NotFound,
    Dropped(DropReason),
    Retry(RetryReason),
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum DropReason {
    FailedSimulation,
    Reverted,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum RetryReason {
    Reorged,
}

impl FullPayload {
    pub fn id(&self) -> &PayloadId {
        &self.details.id
    }

    pub fn status(&self) -> PayloadStatus {
        self.status.clone()
    }

    pub fn set_status(&mut self, status: PayloadStatus) {
        self.status = status;
    }

    pub fn details(&self) -> PayloadDetails {
        self.details.clone()
    }
}
