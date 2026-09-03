use std::fmt::Debug;

use async_trait::async_trait;
use eyre::{Report, Result};

use hyperlane_core::{
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId,
};

/// A generic trait to read/write Checkpoints offchain
#[async_trait]
pub trait CheckpointSyncer: Debug + Send + Sync {
    /// Read the backfill floor of this Syncer: the highest checkpoint index such
    /// that every checkpoint in `[0, floor]` was fully verified (fetched,
    /// signature-recovered and value-matched, or written by this validator).
    /// Unlike `latest_index` — which advances after the first submitted chunk,
    /// before history is complete — the floor only advances once a full
    /// backfill drain is verified, so restarts can skip re-submitting history.
    ///
    /// Defaults to `None` (no floor, full backfill as before). Backends that
    /// cannot persist the marker keep this default and safely degrade to full
    /// backfills.
    async fn backfill_floor_index(&self) -> Result<Option<u32>> {
        Ok(None)
    }
    /// Writes the backfill floor of this Syncer. Best-effort: backends without
    /// durable marker support keep the default no-op and degrade to full
    /// backfills on restart.
    async fn write_backfill_floor_index(&self, _index: u32) -> Result<()> {
        Ok(())
    }
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
    /// Writes the provided log message to the storage destination.
    /// This log is publicly available. It must not contain sensitive information.
    async fn write_reorg_rpc_responses(&self, _log: String) -> Result<()> {
        Err(Report::msg("Destination does not support log writing."))
    }
    /// Read the reorg status of the chain being validated
    async fn reorg_status(&self) -> Result<ReorgEventResponse>;
}
