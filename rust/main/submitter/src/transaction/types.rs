// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::ops::Deref;

use chrono::{DateTime, Utc};
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
    pub id: TransactionId,
    /// all historic tx identifiers this transaction has had, obtained by hashing its contents.
    /// a `Transaction` may have had more than one hash because this changes
    /// when gas price is escalated
    pub tx_hashes: Vec<H512>,
    /// may include nonce, gas price, etc
    pub vm_specific_data: VmSpecificTxData,
    /// this is a vec to accommodate batching
    pub payload_details: Vec<PayloadDetails>,
    pub status: TransactionStatus,
    /// incremented on submission / gas escalation
    pub submission_attempts: u32,
    /// the date and time the transaction was created in-memory by the submitter
    pub creation_timestamp: DateTime<Utc>,
    /// the date and time the transaction was last submitted
    pub last_submission_attempt: Option<DateTime<Utc>>,
}

#[derive(Default, Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Hash)]
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
    /// the tx was drop either by the submitter or by the chain
    Dropped(DropReason),
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq, Hash)]
pub enum DropReason {
    /// currently only assigned when a reorg is detected
    DroppedByChain,
    /// dropped by the submitter
    FailedSimulation,
}

// add nested enum entries as we add VMs
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub enum VmSpecificTxData {
    Evm,
    Svm(SealevelTxPrecursor),
    CosmWasm,
}
