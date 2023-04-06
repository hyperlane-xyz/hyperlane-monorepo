use core::str::FromStr;
use std::collections::HashMap;
use std::path::PathBuf;

use ethers::types::Address;
use eyre::{eyre, Context, Report, Result};
use prometheus::{IntGauge, IntGaugeVec};
use rusoto_core::Region;
use serde::Deserialize;
use warp::hyper::body::HttpBody;

use hyperlane_core::config::*;

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
        /// S3 Region
        region: Region,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RawCheckpointSyncerConf {
    LocalStorage {
        path: Option<String>,
    },
    S3 {
        bucket: Option<String>,
        region: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

impl FromRawConf<'_, RawCheckpointSyncerConf> for CheckpointSyncerConf {
    fn from_config(raw: RawCheckpointSyncerConf, cwp: &ConfigPath) -> ConfigResult<Self> {
        match raw {
            RawCheckpointSyncerConf::LocalStorage { path } => Ok(Self::LocalStorage {
                path: path
                    .expect_or_config_err(|| {
                        (
                            cwp + "path",
                            eyre!("Missing `path` for LocalStorage checkpoint syncer"),
                        )
                    })?
                    .parse()
                    .into_config_result(|| cwp + "path")?,
            }),
            RawCheckpointSyncerConf::S3 { bucket, region } => Ok(Self::S3 {
                bucket: bucket.expect_or_config_err(|| {
                    (
                        cwp + "bucket",
                        eyre!("Missing `bucket` for S3 checkpoint syncer"),
                    )
                })?,
                region: region
                    .expect_or_config_err(|| {
                        (
                            cwp + "region",
                            eyre!("Missing `region` for S3 checkpoint syncer"),
                        )
                    })?
                    .parse()
                    .into_config_result(|| cwp + "region")?,
            }),
            RawCheckpointSyncerConf::Unknown => Err(ConfigParsingError::new(
                cwp + "type",
                eyre!("Missing `type` for checkpoint syncer"),
            )),
        }
    }
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
                let [bucket, region]: [&str; 2] = suffix
                    .split('/')
                    .collect::<Vec<_>>()
                    .try_into()
                    .map_err(|_| eyre!("Error parsing storage location; could not split bucket and region ({suffix})"))?;
                Ok(CheckpointSyncerConf::S3 {
                    bucket: bucket.into(),
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
                Box::new(LocalStorage::new(path.clone(), latest_index_gauge))
            }
            CheckpointSyncerConf::S3 { bucket, region } => Box::new(S3Storage::new(
                bucket.clone(),
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
                checkpoint_syncers.insert(Address::from_str(key)?, conf.into());
            } else {
                continue;
            }
        }
        Ok(MultisigCheckpointSyncer::new(checkpoint_syncers))
    }
}
