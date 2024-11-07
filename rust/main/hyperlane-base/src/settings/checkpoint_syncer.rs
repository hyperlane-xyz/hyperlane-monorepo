use crate::{
    settings::ChainConf, CheckpointSyncer, CoreMetrics, GcsStorageClientBuilder, LocalStorage,
    OnchainStorageClient, S3Storage, GCS_SERVICE_ACCOUNT_KEY, GCS_USER_SECRET,
};
use core::str::FromStr;
use eyre::{eyre, Context, Report, Result};
use hyperlane_core::H256;
use prometheus::IntGauge;
use rusoto_core::Region;
use std::{env, path::PathBuf};
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
    OnChain {
        chain_name: String,
        contract_address: H256,
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
            "onchain" => {
                let parts: Vec<&str> = suffix.split('/').collect::<Vec<&str>>();
                if parts.len() != 2 {
                    return Err(eyre!("Invalid onchain checkpoint syncer format"));
                }
                Ok(CheckpointSyncerConf::OnChain {
                    chain_name: parts[0].to_string(),
                    contract_address: parts[1].parse()?,
                })
            }
            _ => Err(eyre!("Unknown storage location prefix `{prefix}`")),
        }
    }
}

impl CheckpointSyncerConf {
    /// Turn conf info a Checkpoint Syncer
    pub async fn build(
        &self,
        latest_index_gauge: Option<IntGauge>,
        chain_setup: Option<&ChainConf>,
        metrics: Option<&CoreMetrics>,
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
            CheckpointSyncerConf::OnChain {
                chain_name,
                contract_address,
            } => {
                // Build the onchain checkpoint storage contract interface
                let onchain_checkpoint_storage = chain_setup
                    .unwrap()
                    .build_onchain_checkpoint_storage(contract_address.to_owned(), metrics.unwrap())
                    .await?;
                Box::new(OnchainStorageClient::new(onchain_checkpoint_storage))
            }
        })
    }
}
