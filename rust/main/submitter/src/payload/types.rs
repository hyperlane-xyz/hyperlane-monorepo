// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::ops::Deref;

use chrono::{DateTime, Utc};
use uuid::Uuid;

use hyperlane_core::{identifiers::UniqueIdentifier, H256, U256};

use crate::{chain_tx_adapter::SealevelPayload, transaction::TransactionStatus};

pub type PayloadId = UniqueIdentifier;
type Address = H256;

/// Struct needed to keep lightweight references to payloads, such that when included in logs there's no noise.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub struct PayloadDetails {
    /// unique payload identifier
    pub id: PayloadId,

    /// to be printed in logs for easier debugging. This may include the Hyperlane Message ID
    pub metadata: String,

    // unused field in MVP
    /// view calls for checking if batch subcalls reverted. EVM-specific for now.
    pub success_criteria: Option<(Vec<u8>, Address)>,
}

/// Full details about a payload. This is instantiated by the caller of PayloadDispatcher
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct FullPayload {
    /// reference to payload used by other components
    pub details: PayloadDetails,
    /// calldata on EVM. On SVM, it is the serialized instructions and account list. On Cosmos, it is the serialized vec of msgs
    pub data: VmSpecificPayloadData,
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

impl FullPayload {
    pub fn id(&self) -> &PayloadId {
        &self.details.id
    }

    #[cfg(test)]
    pub fn random() -> Self {
        let id = PayloadId::random();
        let details = PayloadDetails {
            id: id.clone(),
            metadata: format!("payload-{}", id.to_string()),
            success_criteria: None,
        };
        FullPayload {
            details,
            data: VmSpecificPayloadData::default(),
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

// add nested enum entries as we add VMs
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum VmSpecificPayloadData {
    #[default]
    Evm,
    Svm(SealevelPayload),
    CosmWasm,
}
