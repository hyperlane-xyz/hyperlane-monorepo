use uuid::Uuid;

use crate::adapter::chains::ethereum::precursor::EthereumTxPrecursor;
use crate::payload::{FullPayload, PayloadDetails};
use crate::transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData};

pub struct TransactionFactory {}

impl TransactionFactory {
    pub fn build(precursor: EthereumTxPrecursor, details: Vec<PayloadDetails>) -> Transaction {
        Transaction {
            uuid: TransactionUuid::new(Uuid::new_v4()),
            tx_hashes: vec![],
            vm_specific_data: VmSpecificTxData::Evm(precursor),
            payload_details: details,
            status: TransactionStatus::PendingInclusion,
            submission_attempts: 0,
            creation_timestamp: chrono::Utc::now(),
            last_submission_attempt: None,
        }
    }
}
