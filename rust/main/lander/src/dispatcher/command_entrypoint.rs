use async_trait::async_trait;

use crate::{AdaptsChainAction, DispatcherEntrypoint, LanderError};

#[async_trait]
pub trait CommandEntrypoint: Sync + Send {
    async fn execute_command(&self, action: AdaptsChainAction) -> Result<(), LanderError>;
    async fn refresh_finalized_transaction_count(&self) -> Result<u64, LanderError>;
}

#[async_trait]
impl CommandEntrypoint for DispatcherEntrypoint {
    async fn execute_command(&self, action: AdaptsChainAction) -> Result<(), LanderError> {
        self.inner.adapter.run_command(action).await
    }

    async fn refresh_finalized_transaction_count(&self) -> Result<u64, LanderError> {
        let count = self
            .inner
            .tx_db
            .recount_finalized_transaction_count()
            .await?;
        self.inner
            .metrics
            .set_finalized_transactions_metric(count, &self.inner.domain);
        Ok(count)
    }
}
