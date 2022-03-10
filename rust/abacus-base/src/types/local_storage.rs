use abacus_core::SignedCheckpoint;

use async_trait::async_trait;
use color_eyre::Result;

use crate::traits::CheckpointSyncer;
/// Type for reading/write to LocalStorage
pub struct LocalStorage {
    /// base path
    pub path: String,
}

impl LocalStorage {
    fn key(&self, index: u32) -> String {
        let mut path = String::from(self.path.clone());
        path.push_str(&format!("/{}.json", index));
        path
    }
}
#[async_trait]
impl CheckpointSyncer for LocalStorage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        let mut path = String::from(self.path.clone());
        path.push_str("/index.json");
        match tokio::fs::read(path).await {
            Ok(data) => {
                let index = serde_json::from_slice(&data)?;
                Ok(Some(index))
            }
            _ => Ok(None),
        }
    }
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpoint>> {
        match tokio::fs::read(self.key(index)).await {
            Ok(data) => {
                let checkpoint = serde_json::from_slice(&data)?;
                Ok(Some(checkpoint))
            }
            _ => Ok(None),
        }
    }
    async fn write_checkpoint(&self, signed_checkpoint: SignedCheckpoint) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(&signed_checkpoint)?;
        tokio::fs::write(
            self.key(signed_checkpoint.checkpoint.index),
            &serialized_checkpoint,
        )
        .await?;
        Ok(())
    }
}
