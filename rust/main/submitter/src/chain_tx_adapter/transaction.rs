// TODO: re-enable clippy warnings
#![allow(dead_code)]

use uuid::Uuid;

use hyperlane_core::{H256, H512};

use super::PayloadId;

pub type TransactionId = Uuid;
type SignerAddress = H256;

/// Full details about a transaction
pub struct Transaction {
    /// unique tx identifier. Used as primary key in the db.
    id: TransactionId,
    /// tx identifier obtained by hashing its contents. This may change when gas price is escalated
    hash: Option<H512>,
    /// may include nonce, gas price, etc
    vm_specific_data: VmSpecificTxData,
    /// this is a vec to accommodate batching
    payload_details: Vec<PayloadId>,
    status: TransactionStatus,
    /// incremented on submission / gas escalation
    submission_attempts: u32,
}

pub enum TransactionStatus {
    /// default state. If the tx appears dropped from the mempool, it goes back to this state
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
pub enum VmSpecificTxData {
    Evm, // likely `TypedTransaction`, imported from ethers-rs
    Svm, // likely `Transaction` is imported from solana-sdk
    CosmWasm,
}
