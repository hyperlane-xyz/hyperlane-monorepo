// TODO: re-enable clippy warnings
#![allow(dead_code)]

use async_trait::async_trait;
use eyre::Result;

use crate::{
    chain_tx_adapter::GasLimit,
    payload::{FullPayload, PayloadId, PayloadStatus},
};

use super::{PayloadDispatcherSettings, PayloadDispatcherState};

#[async_trait]
pub trait Entrypoint {
    async fn send_payload(&self, payloads: FullPayload) -> Result<()>;
    async fn payload_status(&self, payload_id: PayloadId) -> Result<PayloadStatus>;
    async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<GasLimit>;
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
    async fn send_payload(&self, payload: FullPayload) -> Result<()> {
        self.inner.db.store_payload_by_id(payload.clone()).await?;
        Ok(())
    }

    async fn payload_status(&self, payload_id: PayloadId) -> Result<PayloadStatus> {
        let payload = self.inner.db.retrieve_payload_by_id(&payload_id).await?;
        let status = payload
            .map(|payload| payload.status())
            .unwrap_or(PayloadStatus::NotFound);
        Ok(status)
    }

    async fn estimate_gas_limit(&self, payload: &FullPayload) -> Result<GasLimit> {
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
    use hyperlane_base::db::DbResult;

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
            async fn build_transactions(&self, payloads: Vec<FullPayload>) -> Vec<Transaction>;
            async fn simulate_tx(&self, tx: &Transaction) -> Result<bool>;
            async fn submit(&self, tx: &mut Transaction) -> Result<()>;
            async fn tx_status(&self, tx: &Transaction) -> Result<TransactionStatus>;
            async fn reverted_payloads(&self, tx: &Transaction) -> Result<Vec<uuid::Uuid>>;
            async fn nonce_gap_exists(&self) -> bool;
            async fn replace_tx(&self, _tx: &Transaction) -> Result<()>;
        }
    }

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

        async fn store_payload_by_id(&self, payload: FullPayload) -> DbResult<()> {
            self.payloads
                .lock()
                .unwrap()
                .insert(payload.id().clone(), payload);
            Ok(())
        }
    }

    fn set_up() -> Box<dyn Entrypoint> {
        let adapter = Box::new(MockAdapter::new()) as Box<dyn AdaptsChain>;
        let db = Box::new(MockDb::new()) as Box<dyn PayloadDb>;
        let entrypoint_state = PayloadDispatcherState::new(db, adapter);
        Box::new(PayloadDispatcherEntrypoint::from_inner(entrypoint_state))
    }

    #[tokio::test]
    async fn test_write_and_read_payload_mock_db() {
        let entrypoint = set_up();
        let payload = FullPayload::default();
        let payload_id = payload.id().clone();

        entrypoint.send_payload(payload.clone()).await.unwrap();
        let status = entrypoint.payload_status(payload_id.clone()).await.unwrap();

        assert_eq!(status, PayloadStatus::ReadyToSubmit);
    }

    #[tokio::test]
    async fn test_write_and_read_payload_rocksdb() {}
}
