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
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use eyre::Result;
    use hyperlane_base::db::{DbResult, HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;

    use super::*;
    use crate::{
        adapter::*,
        dispatcher::{
            metrics::DispatcherMetrics, test_utils::MockAdapter, PayloadDb, TransactionDb,
        },
        payload::*,
        transaction::*,
    };

    struct MockDb {
        // need arcmutex for interior mutability
        payloads: Arc<Mutex<HashMap<PayloadUuid, FullPayload>>>,
    }

    impl MockDb {
        fn new() -> Self {
            Self {
                payloads: Arc::new(Mutex::new(HashMap::new())),
            }
        }
    }

    #[async_trait]
    impl PayloadDb for MockDb {
        async fn retrieve_payload_by_uuid(
            &self,
            payload_uuid: &PayloadUuid,
        ) -> DbResult<Option<FullPayload>> {
            Ok(self.payloads.lock().unwrap().get(payload_uuid).cloned())
        }

        async fn store_payload_by_uuid(&self, payload: &FullPayload) -> DbResult<()> {
            self.payloads
                .lock()
                .unwrap()
                .insert(payload.uuid().clone(), payload.clone());
            Ok(())
        }

        async fn store_tx_uuid_by_payload_uuid(
            &self,
            _payload_uuid: &PayloadUuid,
            _tx_uuid: &TransactionUuid,
        ) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_tx_uuid_by_payload_uuid(
            &self,
            _payload_uuid: &PayloadUuid,
        ) -> DbResult<Option<TransactionUuid>> {
            todo!()
        }

        async fn retrieve_payload_index_by_uuid(
            &self,
            _payload_uuid: &PayloadUuid,
        ) -> DbResult<Option<u32>> {
            todo!()
        }

        async fn store_payload_uuid_by_index(
            &self,
            _index: u32,
            _payload_uuid: &PayloadUuid,
        ) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_payload_uuid_by_index(
            &self,
            _index: u32,
        ) -> DbResult<Option<PayloadUuid>> {
            todo!()
        }

        async fn store_highest_index(&self, _index: u32) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_highest_index(&self) -> DbResult<u32> {
            todo!()
        }

        async fn store_payload_index_by_uuid(
            &self,
            _index: u32,
            _payload_uuid: &PayloadUuid,
        ) -> DbResult<()> {
            todo!()
        }
    }

    #[async_trait]
    impl TransactionDb for MockDb {
        async fn retrieve_transaction_by_uuid(
            &self,
            _tx_uuid: &TransactionUuid,
        ) -> DbResult<Option<Transaction>> {
            unimplemented!()
        }

        async fn store_transaction_by_uuid(&self, _tx: &Transaction) -> DbResult<()> {
            unimplemented!()
        }

        async fn retrieve_transaction_uuid_by_index(
            &self,
            _index: u32,
        ) -> DbResult<Option<TransactionUuid>> {
            todo!()
        }

        async fn store_highest_index(&self, _index: u32) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_highest_index(&self) -> DbResult<u32> {
            todo!()
        }

        async fn store_transaction_uuid_by_index(
            &self,
            _index: u32,
            _tx_uuid: &TransactionUuid,
        ) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_transaction_index_by_uuid(
            &self,
            _tx_uuid: &TransactionUuid,
        ) -> DbResult<Option<u32>> {
            todo!()
        }

        async fn store_transaction_index_by_uuid(
            &self,
            _index: u32,
            _tx_uuid: &TransactionUuid,
        ) -> DbResult<()> {
            todo!()
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

    #[tokio::test]
    async fn test_write_and_read_payload_mock_db() {
        let db = Arc::new(MockDb::new());
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
