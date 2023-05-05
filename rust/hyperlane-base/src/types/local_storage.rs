use async_trait::async_trait;
use derive_new::new;
use eyre::{Context, Result};
use prometheus::IntGauge;
use std::path::PathBuf;

use hyperlane_core::{SignedAnnouncement, SignedCheckpoint, SignedCheckpointWithMessageId};

use crate::traits::CheckpointSyncer;

#[derive(Debug, Clone, new)]
/// Type for reading/write to LocalStorage
pub struct LocalStorage {
    /// base path
    path: PathBuf,
    latest_index: Option<IntGauge>,
}

impl LocalStorage {
    fn checkpoint_file_path(&self, index: u32) -> PathBuf {
        self.path.join(format!("{}.json", index))
    }

    fn checkpoint_with_message_id_file_path(&self, index: u32) -> PathBuf {
        self.path.join(format!("{}_with_id.json", index))
    }

    fn latest_index_file_path(&self) -> PathBuf {
        self.path.join("index.json")
    }

    async fn write_index(&self, index: u32) -> Result<()> {
        let path = self.latest_index_file_path();
        tokio::fs::write(&path, index.to_string())
            .await
            .with_context(|| format!("Writing index to {path:?}"))?;
        Ok(())
    }

    fn announcement_file_path(&self) -> PathBuf {
        self.path.join("announcement.json")
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

    async fn fetch_checkpoint_with_message_id(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        match tokio::fs::read(self.checkpoint_with_message_id_file_path(index)).await {
            Ok(data) => {
                let checkpoint = serde_json::from_slice(&data)?;
                Ok(Some(checkpoint))
            }
            _ => Ok(None),
        }
    }

    async fn write_checkpoint(&self, signed_checkpoint: &SignedCheckpoint) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(signed_checkpoint)?;
        let path = self.checkpoint_file_path(signed_checkpoint.value.index);
        tokio::fs::write(&path, &serialized_checkpoint)
            .await
            .with_context(|| format!("Writing checkpoint to {path:?}"))?;

        match self.latest_index().await? {
            Some(current_latest_index) => {
                if current_latest_index < signed_checkpoint.value.index {
                    self.write_index(signed_checkpoint.value.index).await?
                }
            }
            None => self.write_index(signed_checkpoint.value.index).await?,
        }

        Ok(())
    }

    async fn write_checkpoint_with_message_id(&self, signed_checkpoint: &SignedCheckpointWithMessageId) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(signed_checkpoint)?;
        let path = self.checkpoint_with_message_id_file_path(signed_checkpoint.value.checkpoint.index);
        tokio::fs::write(&path, &serialized_checkpoint)
            .await
            .with_context(|| format!("Writing checkpoint with ID to {path:?}"))?;

        // match self.latest_index().await? {
        //     Some(current_latest_index) => {
        //         if current_latest_index < signed_checkpoint.value.checkpoint.index {
        //             self.write_index(signed_checkpoint.value.checkpoint.index).await?
        //         }
        //     }
        //     None => self.write_index(signed_checkpoint.value.checkpoint.index).await?,
        // }

        Ok(())
    }

    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        let serialized_announcement = serde_json::to_string_pretty(signed_announcement)?;
        let path = self.announcement_file_path();
        tokio::fs::write(&path, &serialized_announcement)
            .await
            .with_context(|| format!("Writing announcement to {path:?}"))?;
        Ok(())
    }

    fn announcement_location(&self) -> String {
        format!("file://{}", self.path.to_str().unwrap())
    }
}
