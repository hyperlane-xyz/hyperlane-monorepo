use core::str::FromStr;
use ethers::types::Address;
use tracing::instrument;
use std::collections::HashMap;

use abacus_core::SignedCheckpoint;
use async_trait::async_trait;
use color_eyre::Report;
use color_eyre::Result;

use crate::S3Storage;
use crate::{CheckpointSyncer, LocalStorage, MultisigCheckpointSyncer};

/// Checkpoint Syncer types
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CheckpointSyncerConf {
    /// A local checkpoint syncer
    LocalStorage {
        /// Path
        path: String,
    },
    /// A checkpoint syncer on S3
    S3 {
        /// Bucket name
        bucket: String,
        /// S3 Region
        region: String,
    },
}

impl CheckpointSyncerConf {
    /// Turn conf info a Checkpoint Syncer
    pub fn try_into_checkpoint_syncer(&self) -> Result<CheckpointSyncers, Report> {
        match self {
            CheckpointSyncerConf::LocalStorage { path } => {
                Ok(CheckpointSyncers::Local(LocalStorage::new(path)))
            }
            CheckpointSyncerConf::S3 { bucket, region } => Ok(CheckpointSyncers::S3(
                S3Storage::new(bucket, region.parse().expect("invalid s3 region")),
            )),
        }
    }
}

/// Config for a MultisigCheckpointSyncer
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct MultisigCheckpointSyncerConf {
    /// The quorum threshold
    threshold: usize,
    /// The checkpoint syncer for each valid validator signer address
    checkpointsyncers: HashMap<String, CheckpointSyncerConf>,
}

impl MultisigCheckpointSyncerConf {
    /// Get a MultisigCheckpointSyncer from the config
    pub fn try_into_multisig_checkpoint_syncer(&self) -> Result<MultisigCheckpointSyncer, Report> {
        let mut checkpoint_syncers = HashMap::new();
        for (key, value) in self.checkpointsyncers.iter() {
            checkpoint_syncers.insert(Address::from_str(key)?, value.try_into_checkpoint_syncer()?);
        }
        Ok(MultisigCheckpointSyncer::new(
            self.threshold,
            checkpoint_syncers,
        ))
    }
}

#[derive(Debug, Clone)]
/// Checkpoint syncers
pub enum CheckpointSyncers {
    /// A local checkpoint syncer
    Local(LocalStorage),
    /// A checkpoint syncer on s3
    S3(S3Storage),
}

#[async_trait]
impl CheckpointSyncer for CheckpointSyncers {
    #[instrument(err, skip(self), level = "debug")]
    /// Read the highest index of this Syncer
    async fn latest_index(&self) -> Result<Option<u32>> {
        match self {
            CheckpointSyncers::Local(syncer) => syncer.latest_index().await,
            CheckpointSyncers::S3(syncer) => syncer.latest_index().await,
        }
    }

    #[instrument(err, skip(self))]
    /// Attempt to fetch the signed checkpoint at this index
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpoint>> {
        match self {
            CheckpointSyncers::Local(syncer) => syncer.fetch_checkpoint(index).await,
            CheckpointSyncers::S3(syncer) => syncer.fetch_checkpoint(index).await,
        }
    }

    #[instrument(err, skip(self))]
    /// Write the signed checkpoint to this syncer
    async fn write_checkpoint(&self, signed_checkpoint: SignedCheckpoint) -> Result<()> {
        match self {
            CheckpointSyncers::Local(syncer) => syncer.write_checkpoint(signed_checkpoint).await,
            CheckpointSyncers::S3(syncer) => syncer.write_checkpoint(signed_checkpoint).await,
        }
    }
}
