// TODO: re-enable clippy warnings
#![allow(dead_code)]

use async_trait::async_trait;
use eyre::{eyre, Result};
use tracing::info;

use crate::{
    adapter::GasLimit,
    error::LanderError,
    payload::{FullPayload, PayloadId, PayloadStatus},
};

use super::{metrics::DispatcherMetrics, DispatcherSettings, DispatcherState};

#[async_trait]
pub trait Entrypoint {
    async fn send_payload(&self, payloads: &FullPayload) -> Result<(), LanderError>;
    async fn payload_status(&self, payload_id: PayloadId) -> Result<PayloadStatus, LanderError>;
    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError>;
}

pub struct DispatcherEntrypoint {
    pub(crate) inner: DispatcherState,
}

impl DispatcherEntrypoint {
    pub async fn try_from_settings(
        settings: DispatcherSettings,
        metrics: DispatcherMetrics,
    ) -> Result<Self> {
        Ok(Self {
            inner: DispatcherState::try_from_settings(settings, metrics).await?,
        })
    }

    fn from_inner(inner: DispatcherState) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl Entrypoint for DispatcherEntrypoint {
    async fn send_payload(&self, payload: &FullPayload) -> Result<(), LanderError> {
        self.inner.payload_db.store_payload_by_id(payload).await?;
        info!(payload=?payload.details, "Sent payload to dispatcher");
        Ok(())
    }

    async fn payload_status(&self, payload_id: PayloadId) -> Result<PayloadStatus, LanderError> {
        let payload = self
            .inner
            .payload_db
            .retrieve_payload_by_id(&payload_id)
            .await?;
        payload
            .map(|payload| payload.status)
            .ok_or(LanderError::PayloadNotFound)
    }

    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, LanderError> {
        self.inner.adapter.estimate_gas_limit(payload).await
    }
}

#[cfg(test)]
pub mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use eyre::Result;
    use hyperlane_base::db::{DbResult, HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;
    use mockall::automock;

    use super::*;
    use crate::{
        adapter::*,
        dispatcher::{
            metrics::DispatcherMetrics, test_utils::MockAdapter, PayloadDb, TransactionDb,
        },
        payload::*,
        transaction::*,
    };

    type PayloadMap = Arc<Mutex<HashMap<PayloadId, FullPayload>>>;

    pub struct DbState {
        // need arcmutex for interior mutability
        payloads: Arc<Mutex<HashMap<PayloadId, FullPayload>>>,
        transactions: Arc<Mutex<HashMap<TransactionId, Transaction>>>,
    }

    impl DbState {
        pub fn new() -> Self {
            Self {
                payloads: Arc::new(Mutex::new(HashMap::new())),
                transactions: Arc::new(Mutex::new(HashMap::new())),
            }
        }
    }

    mockall::mock! {
        pub Db {}

        #[async_trait]
        impl PayloadDb for Db {
            async fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>>;
            async fn store_payload_by_id(&self, payload: &FullPayload) -> DbResult<()>;
            async fn store_tx_id_by_payload_id(
                &self,
                payload_id: &PayloadId,
                tx_id: &TransactionId,
            ) -> DbResult<()>;
            async fn retrieve_tx_id_by_payload_id(
                &self,
                payload_id: &PayloadId,
            ) -> DbResult<Option<TransactionId>>;
            async fn retrieve_payload_index_by_id(
                &self,
                payload_id: &PayloadId,
            ) -> DbResult<Option<u32>>;
            async fn store_payload_id_by_index(
                &self,
                index: u32,
                payload_id: &PayloadId,
            ) -> DbResult<()>;
            async fn retrieve_payload_id_by_index(&self, index: u32) -> DbResult<Option<PayloadId>>;
            async fn store_highest_payload_index(&self, index: u32) -> DbResult<()>;
            async fn retrieve_highest_payload_index(&self) -> DbResult<u32>;
            async fn store_payload_index_by_id(
                &self,
                index: u32,
                payload_id: &PayloadId,
            ) -> DbResult<()>;
        }

        #[async_trait]
        impl TransactionDb for Db {
            async fn retrieve_transaction_by_id(
                &self,
                id: &TransactionId,
            ) -> DbResult<Option<Transaction>>;
            async fn store_transaction_by_id(&self, tx: &Transaction) -> DbResult<()>;
            async fn retrieve_transaction_id_by_index(
                &self,
                index: u32,
            ) -> DbResult<Option<TransactionId>>;
            async fn store_highest_transaction_index(&self, index: u32) -> DbResult<()>;
            async fn retrieve_highest_transaction_index(&self) -> DbResult<u32>;
            async fn store_transaction_id_by_index(
                &self,
                index: u32,
                tx_id: &TransactionId,
            ) -> DbResult<()>;
            async fn retrieve_transaction_index_by_id(
                &self,
                id: &TransactionId,
            ) -> DbResult<Option<u32>>;
            async fn store_transaction_index_by_id(
                &self,
                index: u32,
                tx_id: &TransactionId,
            ) -> DbResult<()>;
        }
    }

    fn set_up(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
    ) -> Box<dyn Entrypoint> {
        let adapter = Arc::new(MockAdapter::new()) as Arc<dyn AdaptsChain>;
        let entrypoint_state = DispatcherState::new(
            payload_db,
            tx_db,
            adapter,
            DispatcherMetrics::dummy_instance(),
            "test".to_string(),
        );
        Box::new(DispatcherEntrypoint::from_inner(entrypoint_state))
    }

    async fn test_entrypoint_db_usage(
        entrypoint: Box<dyn Entrypoint>,
        db: Arc<dyn PayloadDb>,
    ) -> Result<()> {
        let mut payload = FullPayload::default();
        let payload_id = payload.id().clone();

        entrypoint.send_payload(&payload).await?;

        let status = entrypoint.payload_status(payload_id.clone()).await?;
        assert_eq!(status, PayloadStatus::ReadyToSubmit);

        // update the payload's status
        let new_status = PayloadStatus::InTransaction(TransactionStatus::Finalized);
        payload.status = new_status.clone();
        db.store_payload_by_id(&payload).await.unwrap();

        // ensure the db entry was updated
        let status = entrypoint.payload_status(payload_id.clone()).await?;
        assert_eq!(status, new_status);

        Ok(())
    }

    fn mock_db() -> MockDb {
        let mut db = MockDb::new();
        let db_state = Arc::new(Mutex::new(DbState::new()));
        let state_for_write = Arc::clone(&db_state);
        db.expect_store_payload_by_id()
            .withf(move |payload| {
                state_for_write
                    .lock()
                    .unwrap()
                    .payloads
                    .lock()
                    .unwrap()
                    .insert(payload.id().clone(), payload.clone());
                true
            })
            .returning(|_| Ok(()));
        let state_for_read = Arc::clone(&db_state);
        db.expect_retrieve_payload_by_id().returning(move |id| {
            Ok(state_for_read
                .lock()
                .unwrap()
                .payloads
                .lock()
                .unwrap()
                .get(id)
                .cloned())
        });
        db
    }

    #[tokio::test]
    async fn test_write_and_read_payload_mock_db() {
        let db = Arc::new(mock_db());
        let payload_db = db.clone() as Arc<dyn PayloadDb>;
        let tx_db = db as Arc<dyn TransactionDb>;
        let entrypoint = set_up(payload_db.clone(), tx_db);

        test_entrypoint_db_usage(entrypoint, payload_db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_write_and_read_payload_rocksdb() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from_path(temp_dir.path()).unwrap();
        let domain = KnownHyperlaneDomain::Arbitrum.into();
        let rocksdb = Arc::new(HyperlaneRocksDB::new(&domain, db));

        let payload_db = rocksdb.clone() as Arc<dyn PayloadDb>;
        let tx_db = rocksdb.clone() as Arc<dyn TransactionDb>;
        let entrypoint = set_up(payload_db.clone(), tx_db);

        test_entrypoint_db_usage(entrypoint, payload_db)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_estimate_gas_limit() {
        let db = Arc::new(MockDb::new());
        let payload_db = db.clone() as Arc<dyn PayloadDb>;
        let tx_db = db as Arc<dyn TransactionDb>;
        let mock_gas_limit = GasLimit::from(8750526);
        let mut mock_adapter = MockAdapter::new();
        mock_adapter
            .expect_estimate_gas_limit()
            .returning(move |_| Ok(Some(mock_gas_limit)));
        let adapter = Arc::new(mock_adapter) as Arc<dyn AdaptsChain>;
        let entrypoint_state = DispatcherState::new(
            payload_db,
            tx_db,
            adapter,
            DispatcherMetrics::dummy_instance(),
            "test".to_string(),
        );
        let entrypoint = Box::new(DispatcherEntrypoint::from_inner(entrypoint_state));

        let payload = FullPayload::default();
        let gas_limit = entrypoint
            .estimate_gas_limit(&payload)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(gas_limit, mock_gas_limit);
    }
}
