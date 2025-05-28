use uuid::Uuid;

use crate::adapter::chains::sealevel::SealevelTxPrecursor;
use crate::payload::FullPayload;
use crate::transaction::{Transaction, TransactionId, TransactionStatus, VmSpecificTxData};

pub struct TransactionFactory {}

impl TransactionFactory {
    pub fn build(payload: &FullPayload, precursor: SealevelTxPrecursor) -> Transaction {
        Transaction {
            id: TransactionId::new(Uuid::new_v4()),
            tx_hashes: vec![],
            vm_specific_data: VmSpecificTxData::Svm(precursor),
            payload_details: vec![payload.details.clone()],
            status: TransactionStatus::PendingInclusion,
            submission_attempts: 0,
            creation_timestamp: chrono::Utc::now(),
            last_submission_attempt: None,
        }
    }
}
