use crate::{
    CheckpointSyncer, GcsStorageClientBuilder, LocalStorage, S3Storage, GCS_SERVICE_ACCOUNT_KEY,
    GCS_USER_SECRET,
};
use aws_config::Region;
use core::str::FromStr;
use eyre::{eyre, Context, Report, Result};
use hyperlane_core::{ChainCommunicationError, ReorgEvent};
use prometheus::IntGauge;
use std::{env, path::PathBuf};
use tracing::error;
use ya_gcp::{AuthFlow, ServiceAccountAuth};

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
    /// A checkpoint syncer on Google Cloud Storage
    Gcs {
        /// Bucket name
        bucket: String,
        /// Folder name inside bucket - defaults to the root of the bucket
        folder: Option<String>,
        /// A path to the oauth service account key json file.
        service_account_key: Option<String>,
        /// Path to oauth user secrets, like those created by
        /// `gcloud auth application-default login`
        user_secrets: Option<String>,
    },
}

/// Checkpoint Syncer errors
#[derive(Debug, thiserror::Error)]
pub enum CheckpointSyncerBuildError {
    /// A reorg event has been detected in the checkpoint syncer when building it
    #[error("Fatal: A reorg event has been detected. Please reach out for help, this is a potentially serious error impacting signed messages. {0:?}")]
    ReorgEvent(ReorgEvent),
    /// Error communicating with the chain
    #[error(transparent)]
    ChainError(#[from] ChainCommunicationError),
    /// Other errors
    #[error(transparent)]
    Other(#[from] Report),
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
                    // Wildly, aws_config doesn't provide any client-side way to validate a region string, so while
                    // we still have Rusoto around we just use that to validate the region string :)
                    region: aws_config::Region::new(
                        region
                            .parse::<rusoto_core::Region>()
                            .context("Invalid region when parsing storage location")?
                            .name()
                            .to_owned(),
                    ),
                })
            }
            "file" => Ok(CheckpointSyncerConf::LocalStorage {
                path: suffix.into(),
            }),
            // for google cloud both options (with or without folder) from str are for anonymous access only
            // or env variables parsing
            "gs" => {
                let service_account_key = env::var(GCS_SERVICE_ACCOUNT_KEY).ok();
                let user_secrets = env::var(GCS_USER_SECRET).ok();
                let url_components = suffix.split('/').collect::<Vec<&str>>();
                let (bucket, folder): (&str, Option<String>) = match url_components.len() {
                    2 => Ok((url_components[0], None)),
                    3 => Ok((url_components[0], Some(url_components[1].to_owned()))),
                    _ => Err(eyre!("Error parsing storage location; could not split bucket and folder ({suffix})"))
                }?;
                match folder {
                    None => Ok(CheckpointSyncerConf::Gcs {
                        bucket: bucket.into(),
                        folder: None,
                        service_account_key,
                        user_secrets,
                    }),
                    Some(folder) => Ok(CheckpointSyncerConf::Gcs {
                        bucket: bucket.into(),
                        folder: Some(folder),
                        service_account_key,
                        user_secrets,
                    }),
                }
            }
            _ => Err(eyre!("Unknown storage location prefix `{prefix}`")),
        }
    }
}

impl CheckpointSyncerConf {
    /// Turn conf info a Checkpoint Syncer
    ///
    /// # Panics
    ///
    /// Panics if a reorg event has been posted to the checkpoint store,
    /// to prevent any operation processing until the reorg is resolved.
    pub async fn build_and_validate(
        &self,
        latest_index_gauge: Option<IntGauge>,
    ) -> Result<Box<dyn CheckpointSyncer>, CheckpointSyncerBuildError> {
        let syncer: Box<dyn CheckpointSyncer> = self.build(latest_index_gauge).await?;

        match syncer.reorg_status().await {
            Ok(Some(reorg_event)) => {
                return Err(CheckpointSyncerBuildError::ReorgEvent(reorg_event));
            }
            Err(err) => {
                error!(
                    ?err,
                    "Failed to read reorg status. Assuming no reorg occurred."
                );
            }
            _ => {}
        }
        Ok(syncer)
    }

    // keep this private to force all initializations to perform the reorg check via `build_and_validate`
    async fn build(
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
            CheckpointSyncerConf::Gcs {
                bucket,
                folder,
                service_account_key,
                user_secrets,
            } => {
                let auth = if let Some(path) = service_account_key {
                    AuthFlow::ServiceAccount(ServiceAccountAuth::Path(path.into()))
                } else if let Some(path) = user_secrets {
                    AuthFlow::UserAccount(path.into())
                } else {
                    // Public data access only - no `insert`
                    AuthFlow::NoAuth
                };

                Box::new(
                    GcsStorageClientBuilder::new(auth)
                        .build(bucket, folder.to_owned())
                        .await?,
                )
            }
        })
    }
}

#[cfg(test)]
mod test {
    use hyperlane_core::{ReorgPeriod, H256};

    #[tokio::test]
    async fn test_build_and_validate() {
        use super::*;

        // initialize a local checkpoint store
        let temp_checkpoint_dir = tempfile::tempdir().unwrap();
        let checkpoint_path = format!("file://{}", temp_checkpoint_dir.path().to_str().unwrap());
        let checkpoint_syncer_conf = CheckpointSyncerConf::from_str(&checkpoint_path).unwrap();

        let dummy_local_merkle_root =
            H256::from_str("0x8da44bc8198e9874db215ec2000037c58e16918c94743d70c838ecb10e243c64")
                .unwrap();
        let dummy_canonical_merkle_root =
            H256::from_str("0xb437b888332ef12f7260c7f679aad3c96b91ab81c2dc7242f8b290f0b6bba92b")
                .unwrap();
        let dummy_checkpoint_index = 56;
        let unix_timestamp = 1620000000;
        let reorg_period = ReorgPeriod::from_blocks(5);
        let dummy_reorg_event = ReorgEvent {
            local_merkle_root: dummy_local_merkle_root,
            canonical_merkle_root: dummy_canonical_merkle_root,
            checkpoint_index: dummy_checkpoint_index,
            unix_timestamp,
            reorg_period,
        };

        // create a checkpoint syncer and write a reorg event
        // then `drop` it, to simulate a restart
        {
            let checkpoint_syncer = checkpoint_syncer_conf
                .build_and_validate(None)
                .await
                .unwrap();

            checkpoint_syncer
                .write_reorg_status(&dummy_reorg_event)
                .await
                .unwrap();
        }

        // Initialize a new checkpoint syncer and expect it to panic due to the reorg event.
        let result = checkpoint_syncer_conf.build_and_validate(None).await;
        match result {
            Err(CheckpointSyncerBuildError::ReorgEvent(e)) => {
                assert_eq!(e, dummy_reorg_event, "Reported reorg event doesn't match");
            }
            _ => panic!("Expected a reorg event error"),
        }
    }
}
