use crate::{
    adapter::chains::sealevel::SealevelTxPrecursor, payload::FullPayload, transaction::Transaction,
};

pub struct TransactionFactory {}

impl TransactionFactory {
    /// Builds a transaction using the type-safe generic Transaction builder
    pub fn build(precursor: SealevelTxPrecursor, payload: &FullPayload) -> Transaction {
        Transaction::new(precursor, vec![payload.details.clone()])
    }
}
