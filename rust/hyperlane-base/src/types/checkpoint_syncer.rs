use core::str::FromStr;
use std::collections::HashMap;

use ethers::types::Address;
use eyre::{Report, Result};
use prometheus::{IntGauge, IntGaugeVec};

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
    /// Create a CheckpointSyncerConf from a storage location string
    pub fn from_storage_location(storage_location: &str) -> Option<Self> {
        let s3_prefix = "s3://";
        let local_prefix = "file://";
        if let Some(location) = storage_location.strip_prefix(s3_prefix) {
            let pieces: Vec<&str> = location.split('/').collect();
            if pieces.len() == 2 {
                Some(CheckpointSyncerConf::S3 {
                    bucket: pieces[0].into(),
                    region: pieces[1].into(),
                })
            } else {
                None
            }
        } else if let Some(path) = storage_location.strip_prefix(local_prefix) {
            Some(CheckpointSyncerConf::LocalStorage { path: path.into() })
        } else {
            None
        }
    }

    /// Turn conf info a Checkpoint Syncer
    pub fn build(
        &self,
        latest_index_gauge: Option<IntGauge>,
    ) -> Result<Box<dyn CheckpointSyncer>, Report> {
        match self {
            CheckpointSyncerConf::LocalStorage { path } => {
                Ok(Box::new(LocalStorage::new(path, latest_index_gauge)))
            }
            CheckpointSyncerConf::S3 { bucket, region } => Ok(Box::new(S3Storage::new(
                bucket,
                region.parse().expect("invalid s3 region"),
                latest_index_gauge,
            ))),
        }
    }
}

/// Config for a MultisigCheckpointSyncer
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct MultisigCheckpointSyncerConf {
    /// The checkpoint syncer for each valid validator signer address
    checkpointsyncers: HashMap<String, CheckpointSyncerConf>,
}

impl MultisigCheckpointSyncerConf {
    /// Get a MultisigCheckpointSyncer from the config
    pub fn build(
        &self,
        origin: &str,
        validator_checkpoint_index: IntGaugeVec,
    ) -> Result<MultisigCheckpointSyncer, Report> {
        let mut checkpoint_syncers = HashMap::new();
        for (key, value) in self.checkpointsyncers.iter() {
            let gauge =
                validator_checkpoint_index.with_label_values(&[origin, &key.to_lowercase()]);
            checkpoint_syncers.insert(Address::from_str(key)?, value.build(Some(gauge))?.into());
        }
        Ok(MultisigCheckpointSyncer::new(checkpoint_syncers))
    }
}
