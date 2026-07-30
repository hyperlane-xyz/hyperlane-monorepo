use std::{env, path::PathBuf};

use aws_config::Region;
use core::str::FromStr;
use eyre::{eyre, Report, Result};
use prometheus::IntGauge;
use tracing::error;
use url::{Host, Url};
use ya_gcp::{AuthFlow, ServiceAccountAuth};

use hyperlane_core::{ChainCommunicationError, ReorgEventResponse};

use crate::{
    CheckpointSyncer, GcsStorageClientBuilder, LocalStorage, S3Storage, GCS_SERVICE_ACCOUNT_KEY,
    GCS_USER_SECRET,
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
        /// Optional endpoint for an S3-compatible object store
        endpoint: Option<String>,
        /// Whether to force path-style bucket addressing
        force_path_style: Option<bool>,
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
        let (prefix, suffix) = s.split_once("://").ok_or_else(|| {
            eyre!("Error parsing storage location; could not split prefix and suffix ({s})")
        })?;

        match prefix {
            "s3" => {
                let (path, query) = suffix
                    .split_once('?')
                    .map_or((suffix, None), |(path, query)| (path, Some(query)));
                let url_components = path.split('/').collect::<Vec<&str>>();
                let (bucket, region, folder): (&str, &str, Option<String>) =
                    match url_components.len() {
                        2 => Ok((url_components[0], url_components[1], None)),
                        3.. => Ok((
                            url_components[0],
                            url_components[1],
                            Some(url_components[2..].join("/")),
                        )),
                        _ => Err(eyre!(
                            "Error parsing storage location; could not split bucket, region and folder ({path})"
                        )),
                    }?;
                let mut endpoint = None;
                let mut force_path_style = None;
                if let Some(query) = query {
                    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
                        match key.as_ref() {
                            "endpoint" if endpoint.is_none() => {
                                validate_announced_s3_endpoint(&value)?;
                                endpoint = Some(value.into_owned());
                            }
                            "forcePathStyle" if force_path_style.is_none() => {
                                force_path_style = Some(value.parse().map_err(|_| {
                                    eyre!(
                                        "Invalid forcePathStyle value in S3 storage location ({s})"
                                    )
                                })?);
                            }
                            _ => {
                                return Err(eyre!(
                                "Unknown or duplicate S3 storage location parameter `{key}` ({s})"
                            ))
                            }
                        }
                    }
                }
                Ok(CheckpointSyncerConf::S3 {
                    bucket: bucket.into(),
                    folder,
                    region: aws_config::Region::new(region.to_owned()),
                    endpoint,
                    force_path_style,
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
                    _ => Err(eyre!(
                        "Error parsing storage location; could not split bucket and folder ({suffix})"
                    )),
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

fn validate_announced_s3_endpoint(endpoint: &str) -> Result<()> {
    let url = Url::parse(endpoint)
        .map_err(|err| eyre!("Invalid announced S3 endpoint `{endpoint}`: {err}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(eyre!(
            "Announced S3 endpoint must use http or https ({endpoint})"
        ));
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(eyre!(
            "Announced S3 endpoint must not contain credentials, a path, query, or fragment ({endpoint})"
        ));
    }

    match url.host() {
        Some(Host::Domain(host)) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            if !host.contains('.')
                || host == "localhost"
                || host.ends_with(".localhost")
                || host.ends_with(".local")
                || host.ends_with(".internal")
            {
                return Err(eyre!(
                    "Announced S3 endpoint must not target a local hostname ({endpoint})"
                ));
            }
        }
        Some(Host::Ipv4(address)) if is_public_ipv4(address) => {}
        Some(Host::Ipv6(address)) if is_public_ipv6(address) => {}
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => {
            return Err(eyre!(
                "Announced S3 endpoint must not target a local or private IP address ({endpoint})"
            ))
        }
        None => {
            return Err(eyre!(
                "Announced S3 endpoint is missing a host ({endpoint})"
            ))
        }
    }

    Ok(())
}

fn is_public_ipv4(address: std::net::Ipv4Addr) -> bool {
    let octets = address.octets();
    !(address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_documentation()
        || address.is_unspecified()
        || address.is_multicast()
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || octets[0] >= 240)
}

fn is_public_ipv6(address: std::net::Ipv6Addr) -> bool {
    let segments = address.segments();
    (match address.to_ipv4() {
        Some(address) => is_public_ipv4(address),
        None => true,
    }) && !(address.is_loopback()
        || address.is_unspecified()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
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
                endpoint,
                force_path_style,
            } => Box::new(S3Storage::new(
                bucket.clone(),
                folder.clone(),
                region.clone(),
                endpoint.clone(),
                *force_path_style,
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
                endpoint,
                force_path_style,
            } => {
                assert_eq!(bucket, "my-bucket");
                assert_eq!(folder.as_deref(), Some("folder"));
                assert_eq!(region.as_ref(), "eu-central-2");
                assert_eq!(endpoint, None);
                assert_eq!(force_path_style, None);
            }
            _ => panic!("Expected S3 checkpoint syncer"),
        }
    }

    #[test]
    fn test_parse_s3_storage_location_with_custom_endpoint() {
        use super::*;

        let conf = CheckpointSyncerConf::from_str(
            "s3://my-bucket/nyc3/folder?endpoint=http%3A%2F%2Fs3.example.com%3A9000&forcePathStyle=true",
        )
        .unwrap();
        match conf {
            CheckpointSyncerConf::S3 {
                bucket,
                folder,
                region,
                endpoint,
                force_path_style,
            } => {
                assert_eq!(bucket, "my-bucket");
                assert_eq!(folder.as_deref(), Some("folder"));
                assert_eq!(region.as_ref(), "nyc3");
                assert_eq!(endpoint.as_deref(), Some("http://s3.example.com:9000"));
                assert_eq!(force_path_style, Some(true));
            }
            _ => panic!("Expected S3 checkpoint syncer"),
        }
    }

    #[test]
    fn test_rejects_private_announced_s3_endpoint() {
        use super::*;

        let err = CheckpointSyncerConf::from_str(
            "s3://my-bucket/us-east-1?endpoint=http%3A%2F%2F127.0.0.1%3A9000",
        )
        .unwrap_err();
        assert!(err.to_string().contains("local or private IP"));
    }
}
