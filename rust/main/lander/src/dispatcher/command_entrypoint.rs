use async_trait::async_trait;

use crate::{AdaptsChainAction, DispatcherEntrypoint, LanderError, ReorgedTransactionsInspection};

#[async_trait]
pub trait CommandEntrypoint: Sync + Send {
    async fn execute_command(&self, action: AdaptsChainAction) -> Result<(), LanderError>;
    async fn inspect_reorged_transactions(
        &self,
    ) -> Result<ReorgedTransactionsInspection, LanderError>;
    async fn trigger_reprocess_reorged_transactions(&self) -> Result<usize, LanderError>;
}

#[async_trait]
impl CommandEntrypoint for DispatcherEntrypoint {
    async fn execute_command(&self, action: AdaptsChainAction) -> Result<(), LanderError> {
        self.inner.adapter.run_command(action).await
    }

    async fn inspect_reorged_transactions(
        &self,
    ) -> Result<ReorgedTransactionsInspection, LanderError> {
        self.inner.adapter.inspect_reorged_transactions().await
    }

    async fn trigger_reprocess_reorged_transactions(&self) -> Result<usize, LanderError> {
        self.inner
            .adapter
            .trigger_reprocess_reorged_transactions()
            .await
    }
}
