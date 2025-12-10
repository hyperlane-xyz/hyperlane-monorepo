// TODO: re-enable clippy warnings
#![allow(dead_code)]

use std::{collections::HashMap, ops::Deref};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use hyperlane_core::{identifiers::UniqueIdentifier, H256, H512};

#[cfg(feature = "aleo")]
use crate::adapter::chains::AleoTxPrecursor;
use crate::{
    adapter::chains::{EthereumTxPrecursor, RadixTxPrecursor, SealevelTxPrecursor},
    payload::PayloadDetails,
    LanderError,
};

pub type TransactionUuid = UniqueIdentifier;
pub type SignerAddress = H256;

/// Full details about a transaction
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct Transaction {
    /// unique tx identifier. Used as primary key in the db.
    pub uuid: TransactionUuid,
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
    /// the date and time the transaction status was last checked
    pub last_status_check: Option<DateTime<Utc>>,
}

impl Transaction {
    /// Type-safe generic builder for creating a transaction with chain-specific precursor data.
    /// This centralizes the common transaction construction logic across all chain adapters
    /// while ensuring compile-time type safety - you cannot accidentally create a Transaction
    /// with the wrong VmSpecificTxData variant for a given chain.
    ///
    /// # Type Parameters
    ///
    /// * `P` - Any precursor type that implements `Into<VmSpecificTxData>` (AleoTxPrecursor,
    ///   EthereumTxPrecursor, SealevelTxPrecursor, or RadixTxPrecursor)
    ///
    /// # Arguments
    ///
    /// * `precursor` - Chain-specific transaction precursor data
    /// * `payload_details` - One or more payload details (single payload = vec with 1 item, batching = multiple items)
    ///
    /// # Returns
    ///
    /// A new Transaction with:
    /// - Fresh UUID
    /// - Empty tx_hashes
    /// - PendingInclusion status
    /// - 0 submission attempts
    /// - Current timestamp
    /// - No submission or status check timestamps
    pub fn new<P: Into<VmSpecificTxData>>(
        precursor: P,
        payload_details: Vec<PayloadDetails>,
    ) -> Self {
        Self {
            uuid: TransactionUuid::new(Uuid::new_v4()),
            tx_hashes: vec![],
            vm_specific_data: precursor.into(),
            payload_details,
            status: TransactionStatus::PendingInclusion,
            submission_attempts: 0,
            creation_timestamp: Utc::now(),
            last_submission_attempt: None,
            last_status_check: None,
        }
    }
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
    /// in a block older than the configured `reorgPeriod`.
    /// If a transaction fails on-chain, it is still considered finalized because it
    /// consumed a nonce on EVM.
    Finalized,
    /// the tx was drop either by the submitter or by the chain
    Dropped(DropReason),
}

impl TransactionStatus {
    pub fn classify_tx_status_from_hash_statuses(
        statuses: Vec<Result<TransactionStatus, LanderError>>,
    ) -> TransactionStatus {
        let mut status_counts = HashMap::<TransactionStatus, usize>::new();

        // count the occurrences of each successfully queried hash status
        for status in statuses.iter().flatten() {
            let entry = status_counts.entry(status.clone()).or_insert(0);
            *entry = entry.saturating_add(1);
        }

        let finalized_count = status_counts
            .get(&TransactionStatus::Finalized)
            .unwrap_or(&0);
        let included_count = status_counts
            .get(&TransactionStatus::Included)
            .unwrap_or(&0);
        let pending_count = status_counts
            .get(&TransactionStatus::PendingInclusion)
            .unwrap_or(&0);
        let mempool_count = status_counts.get(&TransactionStatus::Mempool).unwrap_or(&0);
        if *finalized_count > 0 {
            return TransactionStatus::Finalized;
        } else if *included_count > 0 {
            return TransactionStatus::Included;
        } else if *mempool_count > 0 {
            return TransactionStatus::Mempool;
        } else if *pending_count > 0 {
            return TransactionStatus::PendingInclusion;
        } else if !status_counts.is_empty() {
            // if the hashmap is not empty, it must mean that the hashes were dropped,
            // because the hashmap is populated only if the status query was successful
            return TransactionStatus::Dropped(DropReason::DroppedByChain);
        }

        // otherwise, return `PendingInclusion`, assuming the rpc is down temporarily and returns errors
        TransactionStatus::PendingInclusion
    }
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
    #[cfg(feature = "aleo")]
    Aleo(Box<AleoTxPrecursor>),
    CosmWasm,
    Evm(Box<EthereumTxPrecursor>),
    Radix(Box<RadixTxPrecursor>),
    Svm(Box<SealevelTxPrecursor>),
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_transaction_status_classification_finalized() {
        use super::*;
        use crate::LanderError;

        let statuses = vec![
            Ok(TransactionStatus::Included),
            Ok(TransactionStatus::Dropped(DropReason::DroppedByChain)),
            Ok(TransactionStatus::PendingInclusion),
            Err(LanderError::NetworkError("Network error".to_string())),
            Ok(TransactionStatus::Finalized),
        ];

        let classified_status = TransactionStatus::classify_tx_status_from_hash_statuses(statuses);
        assert_eq!(classified_status, TransactionStatus::Finalized);
    }

    #[test]
    fn test_transaction_status_classification_included() {
        use super::*;
        use crate::LanderError;

        let statuses = vec![
            Ok(TransactionStatus::Dropped(DropReason::DroppedByChain)),
            Ok(TransactionStatus::Included),
            Ok(TransactionStatus::PendingInclusion),
            Err(LanderError::NetworkError("Network error".to_string())),
        ];

        let classified_status = TransactionStatus::classify_tx_status_from_hash_statuses(statuses);
        assert_eq!(classified_status, TransactionStatus::Included);
    }

    #[test]
    fn test_transaction_status_classification_errors() {
        use super::*;
        use crate::LanderError;

        let statuses = vec![
            Err(LanderError::NetworkError("Network error".to_string())),
            Err(LanderError::NetworkError("Network error".to_string())),
            Err(LanderError::NetworkError("Network error".to_string())),
            Err(LanderError::NetworkError("Network error".to_string())),
        ];

        let classified_status = TransactionStatus::classify_tx_status_from_hash_statuses(statuses);
        assert_eq!(classified_status, TransactionStatus::PendingInclusion);
    }

    #[test]
    fn test_transaction_status_classification_dropped() {
        use super::*;
        use crate::LanderError;

        let statuses = vec![
            Err(LanderError::NetworkError("Network error".to_string())),
            Ok(TransactionStatus::Dropped(DropReason::DroppedByChain)),
            Err(LanderError::NetworkError("Network error".to_string())),
        ];

        let classified_status = TransactionStatus::classify_tx_status_from_hash_statuses(statuses);
        assert_eq!(
            classified_status,
            TransactionStatus::Dropped(DropReason::DroppedByChain)
        );
    }

    #[test]
    fn test_transaction_status_classification_pending() {
        use super::*;
        use crate::LanderError;

        let statuses = vec![
            Ok(TransactionStatus::Dropped(DropReason::DroppedByChain)),
            Ok(TransactionStatus::PendingInclusion),
            Err(LanderError::NetworkError("Network error".to_string())),
        ];

        let classified_status = TransactionStatus::classify_tx_status_from_hash_statuses(statuses);
        assert_eq!(classified_status, TransactionStatus::PendingInclusion);
    }

    #[test]
    fn test_transaction_status_classification_mempool() {
        use super::*;
        use crate::LanderError;

        let statuses = vec![
            Err(LanderError::NetworkError("Network error".to_string())),
            Ok(TransactionStatus::Mempool),
            Ok(TransactionStatus::PendingInclusion),
            Ok(TransactionStatus::Dropped(DropReason::DroppedByChain)),
        ];

        let classified_status = TransactionStatus::classify_tx_status_from_hash_statuses(statuses);
        assert_eq!(classified_status, TransactionStatus::Mempool);
    }
}
