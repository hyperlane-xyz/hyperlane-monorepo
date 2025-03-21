// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::ops::Deref;
use uuid::Uuid;

use hyperlane_core::{identifiers::UniqueIdentifier, H256, H512};

use crate::chain_tx_adapter::SealevelTxPrecursor;
use crate::payload::{FullPayload, PayloadDetails, PayloadId};

pub type TransactionId = UniqueIdentifier;
pub type SignerAddress = H256;

/// Full details about a transaction
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
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
    pub fn new(payload: FullPayload, precursor: SealevelTxPrecursor) -> Self {
        Self {
            id: TransactionId::new(Uuid::new_v4()),
            hash: None,
            vm_specific_data: VmSpecificTxData::Svm(precursor),
            payload_details: vec![payload.details().clone()],
            status: TransactionStatus::PendingInclusion,
            submission_attempts: 0,
        }
    }

    pub fn id(&self) -> &TransactionId {
        &self.id
    }

    pub fn hash(&self) -> Option<&H512> {
        self.hash.as_ref()
    }

    pub fn vm_specific_data(&self) -> &VmSpecificTxData {
        &self.vm_specific_data
    }

    pub fn update_after_submission(
        &mut self,
        hash: H512,
        precursor: SealevelTxPrecursor,
    ) -> &mut Self {
        self.hash = Some(hash);
        self.vm_specific_data = VmSpecificTxData::Svm(precursor);
        self.submission_attempts += 1;
        self
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
    Evm,                      // likely `TypedTransaction`, imported from ethers-rs
    Svm(SealevelTxPrecursor), // likely `Transaction` is imported from solana-sdk
    CosmWasm,
}
