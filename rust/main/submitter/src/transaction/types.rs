// TODO: re-enable clippy warnings
#![allow(dead_code)]

use derive_new::new;
use std::ops::Deref;
use uuid::Uuid;

use hyperlane_core::{identifiers::UniqueIdentifier, H256, H512};

use crate::payload::{PayloadDetails, PayloadId};

pub type TransactionId = UniqueIdentifier;
type SignerAddress = H256;

/// Full details about a transaction
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, new)]
pub struct Transaction {
    /// unique tx identifier. Used as primary key in the db.
    id: TransactionId,
    /// tx identifier obtained by hashing its contents. This may change when gas price is escalated
    hash: Option<H512>,
    /// may include nonce, gas price, etc
    vm_specific_data: VmSpecificTxData,
    /// this is a vec to accommodate batching
    payload_details: Vec<PayloadDetails>,
    status: TransactionStatus,
    /// incremented on submission / gas escalation
    submission_attempts: u32,
}

impl Transaction {
    pub fn id(&self) -> &TransactionId {
        &self.id
    }

    pub fn payload_details(&self) -> &[PayloadDetails] {
        &self.payload_details
    }
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Default)]
pub enum TransactionStatus {
    /// default state. If the tx appears dropped from the mempool, it goes back to this state
    #[default]
    PendingInclusion,
    /// accepted by node, pending inclusion
    Mempool(SignerAddress),
    /// in an unfinalized block
    Included(SignerAddress),
    /// in a block older than the configured `reorgPeriod`
    Finalized(SignerAddress),
    /// currently only assigned when a reorg is detected
    DroppedByChain(SignerAddress),
}

// add nested enum entries as we add VMs
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum VmSpecificTxData {
    Evm, // likely `TypedTransaction`, imported from ethers-rs
    Svm, // likely `Transaction` is imported from solana-sdk
    CosmWasm,
}
