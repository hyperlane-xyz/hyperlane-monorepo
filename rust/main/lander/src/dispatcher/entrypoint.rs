// TODO: re-enable clippy warnings
#![allow(dead_code)]

use async_trait::async_trait;
use eyre::{eyre, Result};
use tracing::info;

use crate::{
    adapter::GasLimit,
    error::LanderError,
    payload::{FullPayload, PayloadStatus, PayloadUuid},
};

use super::{metrics::DispatcherMetrics, DispatcherSettings, DispatcherState};

#[async_trait]
pub trait Entrypoint {
    async fn send_payload(&self, payloads: &FullPayload) -> Result<(), LanderError>;
    async fn payload_status(&self, payload_uuid: PayloadUuid)
        -> Result<PayloadStatus, LanderError>;
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
        self.inner.payload_db.store_payload_by_uuid(payload).await?;
        info!(payload=?payload.details, "Sent payload to dispatcher");
        Ok(())
    }

    async fn payload_status(
        &self,
        payload_uuid: PayloadUuid,
    ) -> Result<PayloadStatus, LanderError> {
        let payload = self
            .inner
            .payload_db
            .retrieve_payload_by_uuid(&payload_uuid)
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

    type PayloadMap = Arc<Mutex<HashMap<PayloadUuid, FullPayload>>>;

    pub struct DbState {
        // need arcmutex for interior mutability
        payloads: Arc<Mutex<HashMap<PayloadUuid, FullPayload>>>,
        transactions: Arc<Mutex<HashMap<TransactionUuid, Transaction>>>,
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
            async fn retrieve_payload_by_uuid(&self, id: &PayloadUuid) -> DbResult<Option<FullPayload>>;
            async fn store_payload_by_uuid(&self, payload: &FullPayload) -> DbResult<()>;
            async fn store_tx_uuid_by_payload_uuid(
                &self,
                payload_uuid: &PayloadUuid,
                tx_uuid: &TransactionUuid,
            ) -> DbResult<()>;
            async fn retrieve_tx_uuid_by_payload_uuid(
                &self,
                payload_uuid: &PayloadUuid,
            ) -> DbResult<Option<TransactionUuid>>;
            async fn retrieve_payload_index_by_uuid(
                &self,
                payload_uuid: &PayloadUuid,
            ) -> DbResult<Option<u32>>;
            async fn store_payload_uuid_by_index(
                &self,
                index: u32,
                payload_uuid: &PayloadUuid,
            ) -> DbResult<()>;
            async fn retrieve_payload_uuid_by_index(&self, index: u32) -> DbResult<Option<PayloadUuid>>;
            async fn store_highest_payload_index(&self, index: u32) -> DbResult<()>;
            async fn retrieve_highest_payload_index(&self) -> DbResult<u32>;
            async fn store_payload_index_by_uuid(
                &self,
                index: u32,
                payload_uuid: &PayloadUuid,
            ) -> DbResult<()>;
        }

        #[async_trait]
        impl TransactionDb for Db {
            async fn retrieve_transaction_by_uuid(
                &self,
                id: &TransactionUuid,
            ) -> DbResult<Option<Transaction>>;
            async fn store_transaction_by_uuid(&self, tx: &Transaction) -> DbResult<()>;
            async fn retrieve_transaction_uuid_by_index(
                &self,
                index: u32,
            ) -> DbResult<Option<TransactionUuid>>;
            async fn store_highest_transaction_index(&self, index: u32) -> DbResult<()>;
            async fn retrieve_highest_transaction_index(&self) -> DbResult<u32>;
            async fn store_transaction_uuid_by_index(
                &self,
                index: u32,
                tx_uuid: &TransactionUuid,
            ) -> DbResult<()>;
            async fn retrieve_transaction_index_by_uuid(
                &self,
                id: &TransactionUuid,
            ) -> DbResult<Option<u32>>;
            async fn store_transaction_index_by_uuid(
                &self,
                index: u32,
                tx_uuid: &TransactionUuid,
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
        let payload_uuid = payload.uuid().clone();

        entrypoint.send_payload(&payload).await?;

        let status = entrypoint.payload_status(payload_uuid.clone()).await?;
        assert_eq!(status, PayloadStatus::ReadyToSubmit);

        // update the payload's status
        let new_status = PayloadStatus::InTransaction(TransactionStatus::Finalized);
        payload.status = new_status.clone();
        db.store_payload_by_uuid(&payload).await.unwrap();

        // ensure the db entry was updated
        let status = entrypoint.payload_status(payload_uuid.clone()).await?;
        assert_eq!(status, new_status);

        Ok(())
    }

    fn mock_db() -> MockDb {
        let mut db = MockDb::new();
        let db_state = Arc::new(Mutex::new(DbState::new()));
        let state_for_write = Arc::clone(&db_state);
        db.expect_store_payload_by_uuid()
            .withf(move |payload| {
                state_for_write
                    .lock()
                    .unwrap()
                    .payloads
                    .lock()
                    .unwrap()
                    .insert(payload.uuid().clone(), payload.clone());
                true
            })
            .returning(|_| Ok(()));
        let state_for_read = Arc::clone(&db_state);
        db.expect_retrieve_payload_by_uuid().returning(move |id| {
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
