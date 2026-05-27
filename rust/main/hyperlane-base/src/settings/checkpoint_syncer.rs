use std::{env, path::PathBuf};

use aws_config::Region;
use core::str::FromStr;
use eyre::{eyre, Report, Result};
use prometheus::IntGauge;
use tracing::error;
use ya_gcp::{AuthFlow, ServiceAccountAuth};

use ethers::types::H160;

use hyperlane_core::{ChainCommunicationError, ReorgEventResponse};

use crate::{
    CheckpointSyncer, GcsStorageClientBuilder, LocalStorage, OnChainCheckpointSyncer, S3Storage,
    GCS_SERVICE_ACCOUNT_KEY, GCS_USER_SECRET,
};

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
    /// An on-chain checkpoint syncer via the CheckpointStorage contract
    OnChain {
        /// The chain name (e.g. "ethereum", "citrea")
        chain_name: String,
        /// The CheckpointStorage contract address
        contract_address: H160,
        /// The validator's address (optional, set by the agent)
        validator_address: Option<H160>,
        /// The RPC URL for the chain (optional, set by the agent)
        rpc_url: Option<String>,
    },
}

impl CheckpointSyncerConf {
    /// Set the validator address for on-chain checkpoint syncer
    pub fn set_validator_address(&mut self, address: H160) {
        if let CheckpointSyncerConf::OnChain {
            ref mut validator_address,
            ..
        } = self
        {
            *validator_address = Some(address);
        }
    }

    /// Set the RPC URL for on-chain checkpoint syncer
    pub fn set_rpc_url(&mut self, url: String) {
        if let CheckpointSyncerConf::OnChain {
            ref mut rpc_url, ..
        } = self
        {
            *rpc_url = Some(url);
        }
    }

    /// Returns the chain name if this is an on-chain syncer
    pub fn onchain_chain_name(&self) -> Option<&str> {
        if let CheckpointSyncerConf::OnChain { chain_name, .. } = self {
            Some(chain_name.as_str())
        } else {
            None
        }
    }
}

/// Checkpoint Syncer errors
#[derive(Debug, thiserror::Error)]
pub enum CheckpointSyncerBuildError {
    /// A reorg event has been detected in the checkpoint syncer when building it
    #[error("Fatal: A reorg event has been detected. Please reach out for help, this is a potentially serious error impacting signed messages. Do NOT forcefully resume operation of this validator. Keep it crashlooping or shut down until receive support. {0:?}")]
    ReorgFlag(ReorgEventResponse),
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
                    region: aws_config::Region::new(region.to_owned()),
                })
            }
            "file" => Ok(CheckpointSyncerConf::LocalStorage {
                path: suffix.into(),
            }),
            "onchain" => {
                let url_components = suffix.split('/').collect::<Vec<&str>>();
                let (chain_name, contract_address) = match url_components.len() {
                    2 => Ok((url_components[0].to_owned(), url_components[1].to_owned())),
                    _ => Err(eyre!("Error parsing storage location; expected onchain://chainName/contractAddress ({suffix})"))
                }?;
                let contract_address = contract_address.strip_prefix("0x").unwrap_or(&contract_address);
                let contract_address = H160::from_str(contract_address)
                    .map_err(|_| eyre!("Invalid contract address in onchain storage location: {contract_address}"))?;
                Ok(CheckpointSyncerConf::OnChain {
                    chain_name,
                    contract_address,
                    validator_address: None,
                    rpc_url: None,
                })
            }
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
    pub async fn build_and_validate(
        &self,
        latest_index_gauge: Option<IntGauge>,
    ) -> Result<Box<dyn CheckpointSyncer>, CheckpointSyncerBuildError> {
        let syncer: Box<dyn CheckpointSyncer> = self.build(latest_index_gauge).await?;

        match syncer.reorg_status().await {
            Ok(event) => {
                if event.exists {
                    return Err(CheckpointSyncerBuildError::ReorgFlag(event));
                }
            }
            Err(err) => {
                error!(
                    ?err,
                    "Failed to read reorg status. Assuming no reorg occurred."
                );
            }
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
            CheckpointSyncerConf::OnChain {
                chain_name,
                contract_address,
                validator_address,
                rpc_url,
            } => {
                let validator_address = validator_address.ok_or_else(|| {
                    eyre::eyre!(
                        "OnChain checkpoint syncer requires a validator address. \
                         Set it in the validator config or pass it when building."
                    )
                })?;
                let rpc_url = rpc_url.clone().ok_or_else(|| {
                    eyre::eyre!(
                        "OnChain checkpoint syncer requires an RPC URL. \
                         Set it in the validator config or pass it when building."
                    )
                })?;
                Box::new(OnChainCheckpointSyncer::new(
                    chain_name.clone(),
                    *contract_address,
                    validator_address,
                    rpc_url,
                    None,
                ))
            }
        })
    }
}

#[cfg(test)]
mod test {
    use std::{fs::File, io::Write};

    use hyperlane_core::{ReorgEvent, ReorgPeriod, H256};

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

        let dummy_reorg_response = ReorgEventResponse {
            exists: true,
            event: Some(dummy_reorg_event.clone()),
            content: Some(serde_json::to_string_pretty(&dummy_reorg_event).unwrap()),
        };

        // Initialize a new checkpoint syncer and expect it to panic due to the reorg event.
        let result = checkpoint_syncer_conf.build_and_validate(None).await;
        match result {
            Err(CheckpointSyncerBuildError::ReorgFlag(e)) => {
                assert_eq!(
                    e, dummy_reorg_response,
                    "Reported reorg response doesn't match"
                );
            }
            _ => panic!("Expected a reorg response error"),
        }
    }

    /// When we can't parse reorg_flag.json
    #[tokio::test]
    async fn test_build_and_validate_invalid_json() {
        use super::*;

        // initialize a local checkpoint store
        let temp_checkpoint_dir = tempfile::tempdir().unwrap();
        let checkpoint_path = format!("file://{}", temp_checkpoint_dir.path().to_str().unwrap());
        let checkpoint_syncer_conf = CheckpointSyncerConf::from_str(&checkpoint_path).unwrap();

        {
            let mut reorg_flag_path = temp_checkpoint_dir.path().to_path_buf();
            reorg_flag_path.push("reorg_flag.json");
            let mut file = File::create(reorg_flag_path).unwrap();
            file.write_all(b"abc").unwrap();
        }

        let dummy_reorg_response = ReorgEventResponse {
            exists: true,
            event: None,
            content: Some("abc".to_string()),
        };
        // Initialize a new checkpoint syncer and expect it to panic due to the reorg event.
        let result = checkpoint_syncer_conf.build_and_validate(None).await;
        match result {
            Err(CheckpointSyncerBuildError::ReorgFlag(e)) => {
                assert_eq!(
                    e, dummy_reorg_response,
                    "Reported reorg event doesn't match"
                );
            }
            _ => panic!("Expected a reorg event error"),
        }
    }

    #[test]
    fn test_parse_s3_storage_location_with_new_region() {
        use super::*;
        let conf = CheckpointSyncerConf::from_str("s3://my-bucket/eu-central-2/folder").unwrap();
        match conf {
            CheckpointSyncerConf::S3 {
                bucket,
                folder,
                region,
            } => {
                assert_eq!(bucket, "my-bucket");
                assert_eq!(folder.as_deref(), Some("folder"));
                assert_eq!(region.as_ref(), "eu-central-2");
            }
            _ => panic!("Expected S3 checkpoint syncer"),
        }
    }
}
