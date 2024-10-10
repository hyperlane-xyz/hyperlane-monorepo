use async_trait::async_trait;
use eyre::Error;
use std::fmt::Debug;

/// Checkpoint storage onchain, implemented in each chain's folder
#[async_trait]
pub trait OnchainCheckpointStorage: Debug + Send + Sync {
    async fn write_to_contract(&self, key: &str, data: &[u8]) -> Result<(), Error>;
    async fn read_from_contract(&self, key: &str) -> Result<Option<Vec<u8>>, Error>;
}
