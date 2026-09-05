use std::path::PathBuf;

use async_trait::async_trait;
use eyre::{Context, Result};
use hyperlane_core::{
    accumulator::incremental::MerkleTreeSnapshot, ReorgEvent, ReorgEventResponse,
    SignedAnnouncement, SignedCheckpointWithMessageId,
};
use prometheus::IntGauge;
use tokio::io::AsyncReadExt;
use tracing::error;

use crate::traits::CheckpointSyncer;

use super::utils::MAX_CHECKPOINT_OBJECT_SIZE;

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

    fn merkle_snapshot_file_path(&self) -> PathBuf {
        self.path.join("merkle_snapshot.json")
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

    async fn read_merkle_snapshot(&self) -> Result<Option<MerkleTreeSnapshot>> {
        let file = match tokio::fs::File::open(self.merkle_snapshot_file_path()).await {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        let mut data = Vec::new();
        file.take(MAX_CHECKPOINT_OBJECT_SIZE as u64)
            .read_to_end(&mut data)
            .await?;
        if data.len() >= MAX_CHECKPOINT_OBJECT_SIZE {
            eyre::bail!("Merkle snapshot exceeds the checkpoint object size limit");
        }
        let snapshot = serde_json::from_slice(&data)?;
        Ok(Some(snapshot))
    }

    async fn write_merkle_snapshot(&self, snapshot: &MerkleTreeSnapshot) -> Result<()> {
        let serialized_snapshot = serde_json::to_string(snapshot)?;
        let path = self.merkle_snapshot_file_path();
        tokio::fs::write(&path, &serialized_snapshot)
            .await
            .with_context(|| format!("Writing merkle snapshot to {path:?}"))?;
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

#[cfg(test)]
mod tests {
    use hyperlane_core::{accumulator::incremental::IncrementalMerkle, H256};

    use super::*;

    #[tokio::test]
    async fn merkle_snapshot_reads_are_bounded_before_decoding() {
        let directory = tempfile::tempdir().expect("temporary checkpoint directory");
        let storage =
            LocalStorage::new(directory.path().to_owned(), None).expect("local checkpoint storage");
        assert_eq!(
            storage.read_merkle_snapshot().await.expect("missing file"),
            None
        );

        let mut tree = IncrementalMerkle::default();
        tree.ingest(H256::from_low_u64_be(1));
        let snapshot = MerkleTreeSnapshot::capture(&tree).expect("snapshot");
        storage
            .write_merkle_snapshot(&snapshot)
            .await
            .expect("write snapshot");
        assert_eq!(
            storage
                .read_merkle_snapshot()
                .await
                .expect("valid snapshot"),
            Some(snapshot.clone())
        );

        for size in [
            MAX_CHECKPOINT_OBJECT_SIZE - 1,
            MAX_CHECKPOINT_OBJECT_SIZE,
            MAX_CHECKPOINT_OBJECT_SIZE + 1,
        ] {
            let mut bytes = serde_json::to_vec(&snapshot).expect("serialized snapshot");
            bytes.resize(size, b' ');
            tokio::fs::write(storage.merkle_snapshot_file_path(), bytes)
                .await
                .expect("write bounded fixture");
            let result = storage.read_merkle_snapshot().await;
            if size < MAX_CHECKPOINT_OBJECT_SIZE {
                assert_eq!(result.expect("below limit"), Some(snapshot.clone()));
            } else {
                assert!(result
                    .expect_err("oversized snapshot")
                    .to_string()
                    .contains("size limit"));
            }
        }
    }
}
