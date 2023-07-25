use core::str::FromStr;
use std::{collections::HashMap, path::PathBuf};

use eyre::{eyre, Context, Report, Result};
use hyperlane_core::H160;
use prometheus::{IntGauge, IntGaugeVec};
use rusoto_core::Region;

use crate::{CheckpointSyncer, LocalStorage, MultisigCheckpointSyncer, S3Storage};

/// Checkpoint Syncer types
#[derive(Debug, Clone)]
pub enum CheckpointSyncerConf {
    /// A local checkpoint syncer
    LocalStorage {
        /// Path
        path: PathBuf,
    },
    /// A checkpoint syncer on S3
    S3 {
        /// Bucket name
        bucket: String,
        /// Folder name inside bucket - defaults to the root of the bucket
        folder: Option<String>,
        /// S3 Region
        region: Region,
    },
}

impl FromStr for CheckpointSyncerConf {
    type Err = Report;

    fn from_str(s: &str) -> Result<Self> {
        let [prefix, suffix]: [&str; 2] =
            s.split("://").collect::<Vec<_>>().try_into().map_err(|_| {
                eyre!("Error parsing storage location; could not split prefix and suffix ({s})")
            })?;

        match prefix {
            "s3" => {
                let url_components = suffix.split('/').collect::<Vec<&str>>();
                let (bucket, region, folder): (&str, &str, Option<String>) = match url_components.len() {
                    2 => Ok((url_components[0], url_components[1], None)),
                    3 .. => Ok((url_components[0], url_components[1], Some(url_components[2..].join("/")))),
                    _ => Err(eyre!("Error parsing storage location; could not split bucket, region and folder ({suffix})"))
                }?;
                Ok(CheckpointSyncerConf::S3 {
                    bucket: bucket.into(),
                    folder,
                    region: region
                        .parse()
                        .context("Invalid region when parsing storage location")?,
                })
            }
            "file" => Ok(CheckpointSyncerConf::LocalStorage {
                path: suffix.into(),
            }),
            _ => Err(eyre!("Unknown storage location prefix `{prefix}`")),
        }
    }
}

impl CheckpointSyncerConf {
    /// Turn conf info a Checkpoint Syncer
    pub fn build(
        &self,
        latest_index_gauge: Option<IntGauge>,
    ) -> Result<Box<dyn CheckpointSyncer>, Report> {
        Ok(match self {
            CheckpointSyncerConf::LocalStorage { path } => {
                Box::new(LocalStorage::new(path.clone(), latest_index_gauge)?)
            }
            CheckpointSyncerConf::S3 {
                bucket,
                folder,
                region,
            } => Box::new(S3Storage::new(
                bucket.clone(),
                folder.clone(),
                region.clone(),
                latest_index_gauge,
            )),
        })
    }
}

/// Config for a MultisigCheckpointSyncer
#[derive(Debug, Clone)]
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
            if let Ok(conf) = value.build(Some(gauge)) {
                checkpoint_syncers.insert(H160::from_str(key)?, conf.into());
            } else {
                continue;
            }
        }
        Ok(MultisigCheckpointSyncer::new(checkpoint_syncers))
    }
}
