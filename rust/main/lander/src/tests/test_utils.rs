use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use tokio::sync::Mutex;

use hyperlane_base::db::{HyperlaneRocksDB, DB};
use hyperlane_core::identifiers::UniqueIdentifier;
use hyperlane_core::KnownHyperlaneDomain;

use crate::dispatcher::*;
use crate::{
    adapter::{chains::ethereum::nonce::db::NonceDb, *},
    error::LanderError,
    payload::*,
    transaction::*,
};

mockall::mock! {
    pub Adapter {
    }

    #[async_trait]
    impl AdaptsChain for Adapter {
        async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<Option<GasLimit>, LanderError>;
        async fn build_transactions(&self, payloads: &[FullPayload]) -> Vec<TxBuildingResult>;
        async fn simulate_tx(&self, tx: &Transaction) -> Result<bool, LanderError>;
        async fn estimate_tx(&self, tx: &mut Transaction) -> Result<(), LanderError>;
        async fn submit(&self, tx: &mut Transaction) -> Result<(), LanderError>;
        async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus, LanderError>;
        async fn get_tx_hash_status(&self, hash: hyperlane_core::H512) -> Result<TransactionStatus, LanderError>;
        async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<PayloadDetails>, LanderError>;
        async fn nonce_gap_exists(&self) -> bool;
        async fn replace_tx(&self, _tx: &Transaction) -> Result<(), LanderError>;
        fn update_vm_specific_metrics(&self, _tx: &Transaction, _metrics: &DispatcherMetrics);
        fn estimated_block_time(&self) -> &std::time::Duration;
        fn max_batch_size(&self) -> u32;
    }
}

pub(crate) fn tmp_dbs() -> (Arc<dyn PayloadDb>, Arc<dyn TransactionDb>, Arc<dyn NonceDb>) {
    let temp_dir = tempfile::tempdir().unwrap();
    let db = DB::from_path(temp_dir.path()).unwrap();
    let domain = KnownHyperlaneDomain::Arbitrum.into();
    let rocksdb = Arc::new(HyperlaneRocksDB::new(&domain, db));

    let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
    let tx_db = rocksdb.clone() as Arc<dyn TransactionDb>;
    let nonce_db = rocksdb.clone() as Arc<dyn NonceDb>;
    (payload_db, tx_db, nonce_db)
}

pub(crate) fn dummy_tx(payloads: Vec<FullPayload>, status: TransactionStatus) -> Transaction {
    let details: Vec<PayloadDetails> = payloads
        .into_iter()
        .map(|payload| payload.details)
        .collect();
    Transaction {
        uuid: UniqueIdentifier::random(),
        tx_hashes: vec![],
        vm_specific_data: VmSpecificTxData::CosmWasm,
        payload_details: details.clone(),
        status,
        submission_attempts: 0,
        creation_timestamp: chrono::Utc::now(),
        last_submission_attempt: None,
    }
}

pub(crate) async fn create_random_txs_and_store_them(
    num: usize,
    payload_db: &Arc<dyn PayloadDb>,
    tx_db: &Arc<dyn TransactionDb>,
    status: TransactionStatus,
) -> Vec<Transaction> {
    let mut txs = Vec::new();
    for _ in 0..num {
        let mut payload = FullPayload::random();
        payload.status = PayloadStatus::InTransaction(status.clone());
        payload_db.store_payload_by_uuid(&payload).await.unwrap();
        let tx = dummy_tx(vec![payload], status.clone());
        tx_db.store_transaction_by_uuid(&tx).await.unwrap();
        txs.push(tx);
    }
    txs
}

pub(crate) async fn initialize_payload_db(payload_db: &Arc<dyn PayloadDb>, payload: &FullPayload) {
    payload_db.store_payload_by_uuid(payload).await.unwrap();
}

pub async fn are_all_txs_in_pool(
    txs: Vec<Transaction>,
    pool: &Arc<Mutex<HashMap<TransactionUuid, Transaction>>>,
) -> bool {
    let pool = pool.lock().await;
    txs.iter().all(|tx| pool.contains_key(&tx.uuid))
}

pub async fn are_no_txs_in_pool(
    txs: Vec<Transaction>,
    pool: &Arc<Mutex<HashMap<TransactionUuid, Transaction>>>,
) -> bool {
    let pool = pool.lock().await;
    txs.iter().all(|tx| !pool.contains_key(&tx.uuid))
}
