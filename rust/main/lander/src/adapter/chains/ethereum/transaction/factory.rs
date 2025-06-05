use uuid::Uuid;

use crate::{
    adapter::chains::ethereum::precursor::EthereumTxPrecursor,
    payload::FullPayload,
    transaction::{Transaction, TransactionStatus, TransactionUuid, VmSpecificTxData},
};

pub struct TransactionFactory {}

impl TransactionFactory {
    pub fn build(payload: &FullPayload, precursor: EthereumTxPrecursor) -> Transaction {
        Transaction {
            uuid: TransactionUuid::new(Uuid::new_v4()),
            tx_hashes: vec![],
            vm_specific_data: VmSpecificTxData::Evm(precursor),
            payload_details: vec![payload.details.clone()],
            status: TransactionStatus::Pending,
            submission_attempts: 0,
            creation_timestamp: chrono::Utc::now(),
            last_submission_attempt: None,
        }
    }
}
