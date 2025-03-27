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
#[derive(Default, Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct Transaction {
    /// unique tx identifier. Used as primary key in the db.
    pub id: TransactionId,
    /// tx identifier obtained by hashing its contents. This may change when gas price is escalated
    pub hash: Option<H512>,
    /// may include nonce, gas price, etc
    pub vm_specific_data: VmSpecificTxData,
    /// this is a vec to accommodate batching
    pub payload_details: Vec<PayloadDetails>,
    pub status: TransactionStatus,
    /// incremented on submission / gas escalation
    pub submission_attempts: u32,
}

impl Transaction {
    pub fn id(&self) -> &TransactionId {
        &self.id
    }

    pub fn hash(&self) -> Option<&H512> {
        self.hash.as_ref()
    }

    pub fn payload_details(&self) -> &[PayloadDetails] {
        &self.payload_details
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

#[derive(Default, Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum TransactionStatus {
    /// default state. If the tx appears dropped from the mempool, it goes back to this state
    #[default]
    PendingInclusion,
    /// accepted by node, pending inclusion
    Mempool,
    /// in an unfinalized block
    Included,
    /// in a block older than the configured `reorgPeriod`
    Finalized,
    /// currently only assigned when a reorg is detected
    DroppedByChain,
}

// add nested enum entries as we add VMs
#[derive(Default, Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum VmSpecificTxData {
    #[default]
    Evm,
    Svm(SealevelTxPrecursor),
    CosmWasm,
}
