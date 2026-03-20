use crate::payload::PayloadDetails;
use crate::transaction::Transaction;

use super::super::precursor::EthereumTxPrecursor;

pub struct TransactionFactory {}

impl TransactionFactory {
    /// Builds a transaction using the type-safe generic Transaction builder
    pub fn build(precursor: EthereumTxPrecursor, details: Vec<PayloadDetails>) -> Transaction {
        Transaction::new(precursor, details)
    }
}
