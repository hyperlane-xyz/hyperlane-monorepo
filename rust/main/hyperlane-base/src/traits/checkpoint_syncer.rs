use std::fmt::Debug;

use async_trait::async_trait;
use eyre::Result;

use hyperlane_core::{ReorgEvent, SignedAnnouncement, SignedCheckpointWithMessageId};

/// A generic trait to read/write Checkpoints offchain
#[async_trait]
pub trait CheckpointSyncer: Debug + Send + Sync {
    /// Read the highest index of this Syncer
    async fn latest_index(&self) -> Result<Option<u32>>;
    /// Writes the highest index of this Syncer
    async fn write_latest_index(&self, index: u32) -> Result<()>;
    /// Update the latest index of this syncer if necessary
    async fn update_latest_index(&self, index: u32) -> Result<()> {
        match self.latest_index().await? {
            None => {
                self.write_latest_index(index).await?;
            }
            Some(curr) => {
                if index > curr {
                    self.write_latest_index(index).await?;
                }
            }
        }
        Ok(())
    }
    /// Attempt to fetch the signed (checkpoint, messageId) tuple at this index
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>>;
    /// Write the signed (checkpoint, messageId) tuple to this syncer
    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()>;
    /// Write the agent metadata to this syncer
    async fn write_metadata(&self, serialized_metadata: &str) -> Result<()>;
    /// Write the signed announcement to this syncer
    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()>;
    /// Return the announcement storage location for this syncer
    fn announcement_location(&self) -> String;
    /// If a bigger than expected reorg was detected on the validated chain, this flag can be set to inform
    /// the validator agent to stop publishing checkpoints. Once any remediation is done, this flag can be reset
    /// to resume operation.
    async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> Result<()>;
    /// Read the reorg status of the chain being validated
    async fn reorg_status(&self) -> Result<Option<ReorgEvent>>;
}
