use crate::payload::PayloadDetails;
use crate::transaction::Transaction;
use crate::FullPayload;

use super::super::precursor::RadixTxPrecursor;

pub struct TransactionFactory {}

impl TransactionFactory {
    /// Builds a transaction using the type-safe generic Transaction builder
    pub fn build(precursor: RadixTxPrecursor, payload: &FullPayload) -> Transaction {
        Transaction::new(precursor, vec![payload.details.clone()])
    }
}
