use crate::adapter::chains::AleoTxPrecursor;
use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::FullPayload;

pub struct TransactionFactory {}

impl TransactionFactory {
    /// Builds a transaction using the type-safe generic Transaction builder
    pub fn build(precursor: AleoTxPrecursor, payload: &FullPayload) -> Transaction {
        Transaction::new(precursor, vec![payload.details.clone()])
    }
}
