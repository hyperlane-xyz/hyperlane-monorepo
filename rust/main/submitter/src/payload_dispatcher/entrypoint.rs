// TODO: re-enable clippy warnings
#![allow(dead_code)]

use async_trait::async_trait;
use eyre::{eyre, Result};

use crate::{
    chain_tx_adapter::GasLimit,
    error::SubmitterError,
    payload::{FullPayload, PayloadId, PayloadStatus},
};

use super::{PayloadDispatcherSettings, PayloadDispatcherState};

#[async_trait]
pub trait Entrypoint {
    async fn send_payload(&self, payloads: &FullPayload) -> Result<(), SubmitterError>;
    async fn payload_status(&self, payload_id: PayloadId) -> Result<PayloadStatus, SubmitterError>;
    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, SubmitterError>;
}

pub struct PayloadDispatcherEntrypoint {
    inner: PayloadDispatcherState,
}

impl PayloadDispatcherEntrypoint {
    pub fn try_from_settings(settings: PayloadDispatcherSettings) -> Result<Self> {
        Ok(Self {
            inner: PayloadDispatcherState::try_from_settings(settings)?,
        })
    }

    fn from_inner(inner: PayloadDispatcherState) -> Self {
        Self { inner }
    }
}

#[async_trait]
impl Entrypoint for PayloadDispatcherEntrypoint {
    async fn send_payload(&self, payload: &FullPayload) -> Result<(), SubmitterError> {
        self.inner.payload_db.store_payload_by_id(payload).await?;
        Ok(())
    }

    async fn payload_status(&self, payload_id: PayloadId) -> Result<PayloadStatus, SubmitterError> {
        let payload = self
            .inner
            .payload_db
            .retrieve_payload_by_id(&payload_id)
            .await?;
        payload
            .map(|payload| payload.status)
            .ok_or(SubmitterError::PayloadNotFound)
    }

    async fn estimate_gas_limit(
        &self,
        payload: &FullPayload,
    ) -> Result<Option<GasLimit>, SubmitterError> {
        self.inner.adapter.estimate_gas_limit(payload).await
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use eyre::Result;
    use hyperlane_base::db::{DbResult, HyperlaneRocksDB, DB};
    use hyperlane_core::KnownHyperlaneDomain;

    use super::*;
    use crate::chain_tx_adapter::*;
    use crate::payload::*;
    use crate::payload_dispatcher::test_utils::MockAdapter;
    use crate::payload_dispatcher::PayloadDb;
    use crate::payload_dispatcher::TransactionDb;
    use crate::transaction::*;

    struct MockDb {
        // need arcmutex for interior mutability
        payloads: Arc<Mutex<HashMap<PayloadId, FullPayload>>>,
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
        async fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>> {
            Ok(self.payloads.lock().unwrap().get(id).cloned())
        }

        async fn store_payload_by_id(&self, payload: &FullPayload) -> DbResult<()> {
            self.payloads
                .lock()
                .unwrap()
                .insert(payload.id().clone(), payload.clone());
            Ok(())
        }

        async fn store_tx_id_by_payload_id(
            &self,
            _payload_id: &PayloadId,
            _tx_id: &TransactionId,
        ) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_tx_id_by_payload_id(
            &self,
            _payload_id: &PayloadId,
        ) -> DbResult<Option<TransactionId>> {
            todo!()
        }

        async fn retrieve_payload_index_by_id(
            &self,
            _payload_id: &PayloadId,
        ) -> DbResult<Option<u32>> {
            todo!()
        }

        async fn store_payload_id_by_index(
            &self,
            _index: u32,
            _payload_id: &PayloadId,
        ) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_payload_id_by_index(&self, _index: u32) -> DbResult<Option<PayloadId>> {
            todo!()
        }

        async fn store_highest_index(&self, _index: u32) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_highest_index(&self) -> DbResult<u32> {
            todo!()
        }

        async fn store_payload_index_by_id(
            &self,
            _index: u32,
            _payload_id: &PayloadId,
        ) -> DbResult<()> {
            todo!()
        }
    }

    #[async_trait]
    impl TransactionDb for MockDb {
        async fn retrieve_transaction_by_id(
            &self,
            _id: &TransactionId,
        ) -> DbResult<Option<Transaction>> {
            unimplemented!()
        }

        async fn store_transaction_by_id(&self, _tx: &Transaction) -> DbResult<()> {
            unimplemented!()
        }

        async fn retrieve_transaction_id_by_index(
            &self,
            _index: u32,
        ) -> DbResult<Option<TransactionId>> {
            todo!()
        }

        async fn store_highest_index(&self, _index: u32) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_highest_index(&self) -> DbResult<u32> {
            todo!()
        }

        async fn store_transaction_id_by_index(
            &self,
            _index: u32,
            _tx_id: &TransactionId,
        ) -> DbResult<()> {
            todo!()
        }

        async fn retrieve_transaction_index_by_id(
            &self,
            _id: &TransactionId,
        ) -> DbResult<Option<u32>> {
            todo!()
        }

        async fn store_transaction_index_by_id(
            &self,
            _index: u32,
            _tx_id: &TransactionId,
        ) -> DbResult<()> {
            todo!()
        }
    }

    fn set_up(
        payload_db: Arc<dyn PayloadDb>,
        tx_db: Arc<dyn TransactionDb>,
    ) -> Box<dyn Entrypoint> {
        let adapter = Arc::new(MockAdapter::new()) as Arc<dyn AdaptsChain>;
        let entrypoint_state = PayloadDispatcherState::new(payload_db, tx_db, adapter);
        Box::new(PayloadDispatcherEntrypoint::from_inner(entrypoint_state))
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
        let entrypoint_state = PayloadDispatcherState::new(payload_db, tx_db, adapter);
        let entrypoint = Box::new(PayloadDispatcherEntrypoint::from_inner(entrypoint_state));

        let payload = FullPayload::default();
        let gas_limit = entrypoint
            .estimate_gas_limit(&payload)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(gas_limit, mock_gas_limit);
    }
}
