use std::path::PathBuf;

use async_trait::async_trait;
use eyre::{Context, Result};
use hyperlane_core::{
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId,
};
use prometheus::IntGauge;
use tracing::error;

use crate::traits::CheckpointSyncer;

#[derive(Debug, Clone)]
/// Type for reading/write to LocalStorage
pub struct LocalStorage {
    /// base path
    path: PathBuf,
    latest_index: Option<IntGauge>,
}

impl LocalStorage {
    /// Create a new LocalStorage checkpoint syncer instance.
    pub fn new(path: PathBuf, latest_index: Option<IntGauge>) -> Result<Self> {
        if !path.exists() {
            std::fs::create_dir_all(&path).with_context(|| {
                format!("Failed to create local checkpoint syncer storage directory at {path:?}")
            })?;
        }
        Ok(Self { path, latest_index })
    }

    fn checkpoint_file_path(&self, index: u32) -> PathBuf {
        self.path.join(format!("{index}_with_id.json"))
    }

    fn latest_index_file_path(&self) -> PathBuf {
        self.path.join("index.json")
    }

    fn announcement_file_path(&self) -> PathBuf {
        self.path.join("announcement.json")
    }

    fn reorg_flag_path(&self) -> PathBuf {
        self.path.join("reorg_flag.json")
    }

    fn reorg_rpc_responses_path(&self) -> PathBuf {
        self.path.join("reorg_rpc_responses.json")
    }

    fn metadata_file_path(&self) -> PathBuf {
        self.path.join("metadata_latest.json")
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

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let path = self.latest_index_file_path();
        tokio::fs::write(&path, index.to_string())
            .await
            .with_context(|| format!("Writing index to {path:?}"))?;
        Ok(())
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let Ok(data) = tokio::fs::read(self.checkpoint_file_path(index)).await else {
            return Ok(None);
        };
        let checkpoint = serde_json::from_slice(&data)?;
        Ok(Some(checkpoint))
    }

    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(signed_checkpoint)?;
        let path = self.checkpoint_file_path(signed_checkpoint.value.index);
        tokio::fs::write(&path, &serialized_checkpoint)
            .await
            .with_context(|| format!("Writing (checkpoint, messageId) to {path:?}"))?;

        Ok(())
    }

    async fn write_metadata(&self, serialized_metadata: &str) -> Result<()> {
        let path = self.metadata_file_path();
        tokio::fs::write(&path, serialized_metadata)
            .await
            .with_context(|| format!("Writing agent metadata to {path:?}"))?;
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
        format!("file://{}", self.path.as_os_str().to_string_lossy())
    }

    async fn write_reorg_status(&self, reorged_event: &ReorgEvent) -> Result<()> {
        let serialized_reorg = serde_json::to_string_pretty(reorged_event)?;
        let path = self.reorg_flag_path();
        tokio::fs::write(&path, &serialized_reorg)
            .await
            .with_context(|| format!("Writing reorg status to {path:?}"))?;
        Ok(())
    }

    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        let data = match tokio::fs::read(self.reorg_flag_path()).await {
            Ok(s) => s,
            Err(err) => {
                error!(?err, "Failed to read file");
                return Ok(ReorgEventResponse {
                    exists: false,
                    event: None,
                    content: None,
                });
            }
        };
        match serde_json::from_slice(&data) {
            Ok(s) => Ok(ReorgEventResponse {
                exists: true,
                event: Some(s),
                content: Some(String::from_utf8_lossy(&data).to_string()),
            }),
            Err(err) => {
                error!(?err, "Failed to parse reorg event");
                Ok(ReorgEventResponse {
                    exists: true,
                    event: None,
                    content: Some(String::from_utf8_lossy(&data).to_string()),
                })
            }
        }
    }

    async fn write_reorg_rpc_responses(&self, log: String) -> Result<()> {
        let path = self.reorg_rpc_responses_path();
        tokio::fs::write(&path, &log)
            .await
            .with_context(|| format!("Writing log to {path:?}"))?;
        Ok(())
    }
}
