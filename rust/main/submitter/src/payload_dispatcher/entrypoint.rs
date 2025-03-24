// TODO: re-enable clippy warnings
#![allow(dead_code)]

use super::{PayloadDispatcherSettings, PayloadDispatcherState};

pub struct PayloadDispatcherEntrypoint {
    inner: PayloadDispatcherState,
}

impl PayloadDispatcherEntrypoint {
    pub fn new(settings: PayloadDispatcherSettings) -> Self {
        Self {
            inner: PayloadDispatcherState::new(settings),
        }
    }

    fn from_inner(inner: PayloadDispatcherState) -> Self {
        Self { inner }
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use eyre::Result;

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

    #[test]
    fn test_payload_dispatcher_entrypoint() {
        let adapter = Box::new(MockAdapter::new()) as Box<dyn AdaptsChain>;
        let entrypoint_state = PayloadDispatcherState::from_adapter(adapter);
        let entrypoint = PayloadDispatcherEntrypoint::from_inner(entrypoint_state);
    }
}
