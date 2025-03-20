// TODO: re-enable clippy warnings
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use uuid::Uuid;

use hyperlane_core::{H256, U256};

pub type PayloadId = Uuid;
type Address = H256;

/// Struct needed to keep lightweight references to payloads, such that when included in logs there's no noise.
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

pub enum PayloadStatus {
    ReadyToSubmit,
    PendingInclusion,
    Included,
    Finalized,
    Dropped(DropReason), // if it fails simulation or reverts
    Retry(RetryReason),  // currently only if reorged
}

pub enum DropReason {}

pub enum RetryReason {}
