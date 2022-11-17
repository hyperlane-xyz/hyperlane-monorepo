use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::SignedCheckpoint;

/// A generic trait to read/write Checkpoints offchain
#[async_trait]
pub trait CheckpointSyncer {
    /// Read the highest index of this Syncer
    async fn latest_index(&self) -> Result<Option<u32>>;
    /// Attempt to fetch the signed checkpoint at this index
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpoint>>;
    /// Write the signed checkpoint to this syncer
    async fn write_checkpoint(&self, signed_checkpoint: SignedCheckpoint) -> Result<()>;
}
