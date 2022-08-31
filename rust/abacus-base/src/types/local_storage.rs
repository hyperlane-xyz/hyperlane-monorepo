use abacus_core::SignedCheckpoint;

use async_trait::async_trait;
use eyre::Result;
use prometheus::IntGauge;

use crate::traits::CheckpointSyncer;

#[derive(Debug, Clone)]
/// Type for reading/write to LocalStorage
pub struct LocalStorage {
    /// base path
    path: String,
    latest_index: Option<IntGauge>,
}

impl LocalStorage {
    /// Constructor
    pub fn new(path: &str, latest_index: Option<IntGauge>) -> Self {
        LocalStorage {
            path: path.to_owned(),
            latest_index,
        }
    }
    fn checkpoint_file_path(&self, index: u32) -> String {
        format!("{}/{index}.json", self.path)
    }

    fn latest_index_file_path(&self) -> String {
        format!("{}/index.json", self.path)
    }

    async fn write_index(&self, index: u32) -> Result<()> {
        tokio::fs::write(self.latest_index_file_path(), index.to_string()).await?;
        Ok(())
    }
}

#[async_trait]
impl CheckpointSyncer for LocalStorage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        match tokio::fs::read(self.latest_index_file_path())
            .await
            .and_then(|data| {
                String::from_utf8(data)
                    .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
            }) {
            Ok(data) => {
                let index = data.parse()?;
                if let Some(gauge) = &self.latest_index {
                    gauge.set(index as i64);
                }
                Ok(Some(index))
            }
            _ => Ok(None),
        }
    }
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpoint>> {
        match tokio::fs::read(self.checkpoint_file_path(index)).await {
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
            self.checkpoint_file_path(signed_checkpoint.checkpoint.index),
            &serialized_checkpoint,
        )
        .await?;

        match self.latest_index().await? {
            Some(current_latest_index) => {
                if current_latest_index < signed_checkpoint.checkpoint.index {
                    self.write_index(signed_checkpoint.checkpoint.index).await?
                }
            }
            None => self.write_index(signed_checkpoint.checkpoint.index).await?,
        }

        Ok(())
    }
}
