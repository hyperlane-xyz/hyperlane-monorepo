#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use eyre::Result;
    use hyperlane_base::db::{DbResult, HyperlaneRocksDB, DB};
    use hyperlane_core::identifiers::UniqueIdentifier;
    use hyperlane_core::KnownHyperlaneDomain;
    use uuid::Uuid;

    use super::*;
    use crate::chain_tx_adapter::*;
    use crate::payload::*;
    use crate::transaction::*;

    mockall::mock! {
        pub Adapter {
        }

        #[async_trait]
        impl AdaptsChain for Adapter {
            async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<Option<GasLimit>, DispatcherError>;
            async fn build_transactions(&self, payloads: &[FullPayload]) -> Result<Vec<TxBuildingResult>, DispatcherError>;
            async fn simulate_tx(&self, tx: &Transaction) -> Result<bool, DispatcherError>;
            async fn submit(&self, tx: &mut Transaction) -> Result<(), DispatcherError>;
            async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus, DispatcherError>;
            async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<uuid::Uuid>, DispatcherError>;
            async fn nonce_gap_exists(&self) -> bool;
            async fn replace_tx(&self, _tx: &Transaction) -> Result<(), DispatcherError>;
            fn estimated_block_time(&self) -> std::time::Duration;
            fn max_batch_size(&self) -> usize;
        }
    }

    pub(crate) fn tmp_dbs() -> (Arc<dyn PayloadDb>, Arc<dyn TransactionDb>) {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();
        let rocksdb = Arc::new(HyperlaneRocksDB::new(&domain, db));

        let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
        let tx_db = rocksdb.clone() as Arc<dyn TransactionDb>;
        (payload_db, tx_db)
    }

    pub(crate) fn dummy_tx(payloads: Vec<FullPayload>) -> Transaction {
        let details: Vec<PayloadDetails> = payloads
            .into_iter()
            .map(|payload| payload.details)
            .collect();
        Transaction {
            id: UniqueIdentifier::random(),
            hash: None,
            vm_specific_data: VmSpecificTxData::Evm,
            payload_details: details.clone(),
            status: Default::default(),
            submission_attempts: 0,
        }
    }

    pub(crate) fn random_txs(num: usize) -> Vec<Transaction> {
        (0..num)
            .map(|_| dummy_tx(vec![FullPayload::random()]))
            .collect::<Vec<_>>()
    }
}
