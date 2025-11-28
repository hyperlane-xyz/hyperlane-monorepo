use async_trait::async_trait;

use crate::{AdaptsChainAction, DispatcherEntrypoint, LanderError};

#[async_trait]
pub trait CommandEntrypoint: Sync + Send {
    async fn execute_command(&self, action: AdaptsChainAction) -> Result<(), LanderError>;
}

#[async_trait]
impl CommandEntrypoint for DispatcherEntrypoint {
    async fn execute_command(&self, action: AdaptsChainAction) -> Result<(), LanderError> {
        self.inner.adapter.run_command(action).await
    }
}
