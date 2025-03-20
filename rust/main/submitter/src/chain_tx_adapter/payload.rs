// TODO: re-enable clippy warnings
#![allow(dead_code)]

use chrono::{DateTime, Utc};
use uuid::Uuid;

use hyperlane_core::{H256, U256};

type Address = H256;

/// Struct needed to keep lightweight references to payloads, such that when included in logs there's no noise.
pub struct PayloadDetails {
    id: Uuid,         // unique payload identifier
    metadata: String, // to be printed in logs for easier debugging. This may include the Hyperlane Message ID

    // unused field in MVP
    success_criteria: Option<(Vec<u8>, Address)>, // view calls for checking if batch subcalls reverted. EVM-specific for now.
}

/// Full details about a payload. This is instantiated by the caller of PayloadDispatcher
pub struct FullPayload {
    details: PayloadDetails, // reference to payload used by other components
    data: Vec<u8>, // calldata on EVM. On SVM, it is the serialized instructions and account list. On Cosmos, it is the serialized vec of msgs
    to: Address,   // defaults to the hyperlane mailbox
    status: PayloadStatus, // defaults to `ReadyToSubmit`

    // unused fields in MVP
    value: Option<U256>,                            // always None initially
    inclusion_soft_deadline: Option<DateTime<Utc>>, // will be up to the adapter to interpret this. Meant to help enforce the new igp social contract requirement (after 30 mins, stop enforcing any gas price caps)
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
