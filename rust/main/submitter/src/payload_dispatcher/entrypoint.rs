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

    // fn
}

#[cfg(test)]
mod tests {
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

    mockall::mock! {
        pub Db {}

        impl PayloadDb for Db {
            fn retrieve_payload_by_id(&self, id: &PayloadId) -> DbResult<Option<FullPayload>>;
            fn store_payload_by_id(&self, payload: FullPayload) -> DbResult<()>;
        }
    }

    #[test]
    fn test_payload_dispatcher_entrypoint() {
        let adapter = Box::new(MockAdapter::new()) as Box<dyn AdaptsChain>;
        let db = Box::new(MockDb::new()) as Box<dyn PayloadDb>;
        let entrypoint_state = PayloadDispatcherState::new(db, adapter);
        let entrypoint = PayloadDispatcherEntrypoint::from_inner(entrypoint_state);
    }
}
