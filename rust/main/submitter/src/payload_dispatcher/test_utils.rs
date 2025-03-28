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
            async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<GasLimit>;
            async fn build_transactions(&self, payloads: &[FullPayload]) -> Result<Vec<Transaction>>;
            async fn simulate_tx(&self, tx: &Transaction) -> Result<bool>;
            async fn submit(&self, tx: &mut Transaction) -> Result<()>;
            async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus>;
            async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<uuid::Uuid>>;
            async fn nonce_gap_exists(&self) -> bool;
            async fn replace_tx(&self, _tx: &Transaction) -> Result<()>;
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

    pub(crate) fn dummy_tx(payloads: Vec<FullPayload>) -> Vec<Transaction> {
        let details = payloads
            .into_iter()
            .map(|payload| payload.details)
            .collect();
        let transaction = Transaction {
            id: Default::default(),
            hash: None,
            vm_specific_data: VmSpecificTxData::Evm,
            payload_details: details,
            status: Default::default(),
            submission_attempts: 0,
        };
        vec![transaction]
    }
}
