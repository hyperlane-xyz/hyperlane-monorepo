use uuid::Uuid;

use crate::chain_tx_adapter::SealevelTxPrecursor;
use crate::payload::FullPayload;
use crate::transaction::{Transaction, TransactionId, TransactionStatus, VmSpecificTxData};

pub struct TransactionFactory {}

impl TransactionFactory {
    pub fn build(payload: &FullPayload, precursor: SealevelTxPrecursor) -> Transaction {
        Transaction {
            id: TransactionId::new(Uuid::new_v4()),
            hash: None,
            vm_specific_data: VmSpecificTxData::Svm(precursor),
            payload_details: vec![payload.details().clone()],
            status: TransactionStatus::PendingInclusion,
            submission_attempts: 0,
        }
    }
}
