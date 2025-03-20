// TODO: re-enable clippy warnings
#![allow(dead_code)]

use hyperlane_core::H256;
use uuid::Uuid;

type PayloadId = Uuid;
type SignerAddress = H256;

/// Full details about a transaction
pub struct Transaction {
    uuid: Uuid,                         // unique tx identifier. Used as primary key in the db.
    tx_hash: Option<H256>, // tx identifier obtained by hashing its contents. This may change when gas price is escalated
    vm_specific_data: VmSpecificTxData, // may include nonce, gas price, etc
    payload_details: Vec<PayloadId>, // this is a vec to accommodate batching
    status: TransactionStatus,
    submission_attempts: u32, // incremented on submission / gas escalation
}

pub enum TransactionStatus {
    PendingInclusion, // default state. If the tx appears dropped from the mempool, it goes back to this state
    Mempool(SignerAddress), // accepted by node, pending inclusion
    Included(SignerAddress), // in an unfinalized block
    Finalized(SignerAddress), // in a block older than the configured `reorgPeriod`
    DroppedByChain(SignerAddress), // currently only assigned when a reorg is detected
}

// add nested enum entries as we add VMs
pub enum VmSpecificTxData {
    Evm, // likely `TypedTransaction`, imported from ethers-rs
    Svm, // likely `Transaction` is imported from solana-sdk
    CosmWasm,
}
