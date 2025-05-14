use std::{fmt, sync::OnceLock, time::Duration};

use async_trait::async_trait;
use aws_config::{timeout::TimeoutConfig, BehaviorVersion, ConfigLoader, Region};
use aws_sdk_s3::{
    error::SdkError,
    operation::{get_object::GetObjectError as SdkGetObjectError, head_object::HeadObjectError},
    Client,
};
use dashmap::DashMap;
use derive_new::new;
use eyre::{bail, Result};
use hyperlane_core::{ReorgEvent, SignedAnnouncement, SignedCheckpointWithMessageId};
use prometheus::IntGauge;
use tokio::sync::OnceCell;

use crate::CheckpointSyncer;

/// The timeout for all S3 operations.
const S3_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const S3_MAX_OBJECT_SIZE: i64 = 50 * 1024; // 50KiB

#[derive(Clone, new)]
/// Type for reading/writing to S3
pub struct S3Storage {
    /// The name of the bucket.
    bucket: String,
    /// A specific folder inside the above repo - set to empty string to use the root of the bucket
    folder: Option<String>,
    /// The region of the bucket.
    region: Region,
    /// A client with AWS credentials. This client is not initialized globally and has a lifetime
    /// tied to the S3Storage instance, so if heavy use of this client is expected, S3Storage
    /// itself should be long-lived.
    #[new(default)]
    authenticated_client: OnceCell<Client>,
    /// The latest seen signed checkpoint index.
    latest_index: Option<IntGauge>,
}

/// A global cache of anonymous S3 clients, per region.
/// We've seen freshly created S3 clients make expensive DNS / TCP
/// requests when creating them. This cache allows us to reuse
/// anonymous clients across the entire agent.
static ANONYMOUS_CLIENT_CACHE: OnceLock<DashMap<Region, OnceCell<Client>>> = OnceLock::new();

fn get_anonymous_client_cache() -> &'static DashMap<Region, OnceCell<Client>> {
    ANONYMOUS_CLIENT_CACHE.get_or_init(DashMap::new)
}

impl fmt::Debug for S3Storage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Storage")
            .field("bucket", &self.bucket)
            .field("folder", &self.folder)
            .field("region", &self.region)
            .finish()
    }
}

impl S3Storage {
    async fn write_to_bucket(&self, key: String, body: &str) -> Result<()> {
        self.authenticated_client()
            .await
            .put_object()
            .bucket(self.bucket.clone())
            .key(self.get_composite_key(key))
            .body(Vec::from(body).into())
            .content_type("application/json")
            .send()
            .await?;

        Ok(())
    }

    /// Check if the metadata for the object satisfies our size constraints.
    /// If the object is too big, we return an error.
    async fn check_metadata(&self, key: String) -> Result<bool> {
        let metadata_req = self
            .anonymous_client()
            .await
            .head_object()
            .bucket(self.bucket.clone())
            .key(self.get_composite_key(key.clone()))
            .send()
            .await;
        match metadata_req {
            Ok(value) => match value.content_length {
                Some(length) if length >= S3_MAX_OBJECT_SIZE => {
                    bail!("Object size for key {key} is too big: {}KiB", length / 1024);
                }
                Some(_) => Ok(true),
                None => Ok(false),
            },
            Err(SdkError::ServiceError(err)) => match err.err() {
                HeadObjectError::NotFound(_) => Ok(false),
                _ => bail!(err.into_err()),
            },
            Err(e) => bail!(e),
        }
    }

    async fn anonymously_read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
        // check for metadata first
        if !self.check_metadata(key.clone()).await? {
            return Ok(None);
        }

        let get_object_result = self
            .anonymous_client()
            .await
            .get_object()
            .bucket(self.bucket.clone())
            .key(self.get_composite_key(key))
            .send()
            .await;
        match get_object_result {
            Ok(res) => Ok(Some(res.body.collect().await?.into_bytes().to_vec())),
            Err(SdkError::ServiceError(err)) => match err.err() {
                SdkGetObjectError::NoSuchKey(_) => Ok(None),
                _ => bail!(err.into_err()),
            },
            Err(e) => bail!(e),
        }
    }

    /// Gets an authenticated S3 client, creating it if it doesn't already exist
    /// within &self.
    async fn authenticated_client(&self) -> &Client {
        self.authenticated_client
            .get_or_init(|| async {
                let config = self.default_aws_sdk_config_loader().load().await;
                Client::new(&config)
            })
            .await
    }

    /// Gets an anonymous S3 client, creating it if it doesn't already exist globally.
    /// An anonymous client doesn't have AWS credentials and will not sign S3
    /// requests with any credentials. We globally cache the clients per region to avoid
    /// expensive DNS / TCP initialization.
    /// We've experienced an inability to make GetObjectRequests to public
    /// S3 buckets when signing with credentials from an AWS account not from the
    /// S3 bucket's AWS account. Additionally, this allows relayer operators to not
    /// require AWS credentials.
    async fn anonymous_client(&self) -> Client {
        let cell = get_anonymous_client_cache()
            .entry(self.region.clone())
            .or_default();

        cell.get_or_init(|| async {
            let config = self
                .default_aws_sdk_config_loader()
                // Make anonymous, important to not require AWS credentials
                // to operate the relayer
                .no_credentials()
                .load()
                .await;
            Client::new(&config)
        })
        .await
        .clone()
    }

    /// A default ConfigLoader with timeout, region, and behavior version.
    /// Unless overridden, credentials will be loaded from the env.
    fn default_aws_sdk_config_loader(&self) -> aws_config::ConfigLoader {
        ConfigLoader::default()
            .timeout_config(
                TimeoutConfig::builder()
                    .operation_timeout(S3_REQUEST_TIMEOUT)
                    .build(),
            )
            .behavior_version(BehaviorVersion::latest())
            .region(self.region.clone())
    }

    fn get_composite_key(&self, key: String) -> String {
        match self.folder.as_deref() {
            None | Some("") => key,
            Some(folder_str) => format!("{}/{}", folder_str, key),
        }
    }

    fn checkpoint_key(index: u32) -> String {
        format!("checkpoint_{index}_with_id.json")
    }

    fn latest_index_key() -> String {
        "checkpoint_latest_index.json".to_owned()
    }

    fn metadata_key() -> String {
        "metadata_latest.json".to_owned()
    }

    fn announcement_key() -> String {
        "announcement.json".to_owned()
    }

    fn reorg_flag_key() -> String {
        "reorg_flag.json".to_owned()
    }
}

#[async_trait]
impl CheckpointSyncer for S3Storage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        let ret = self
            .anonymously_read_from_bucket(S3Storage::latest_index_key())
            .await?
            .map(|data| serde_json::from_slice(&data))
            .transpose()
            .map_err(Into::into);

        if let Ok(Some(latest_index)) = ret {
            if let Some(gauge) = &self.latest_index {
                gauge.set(latest_index as i64);
            }
        }

        ret
    }

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let serialized_index = serde_json::to_string(&index)?;
        self.write_to_bucket(S3Storage::latest_index_key(), &serialized_index)
            .await?;
        Ok(())
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        self.anonymously_read_from_bucket(S3Storage::checkpoint_key(index))
            .await?
            .map(|data| serde_json::from_slice(&data))
            .transpose()
            .map_err(Into::into)
    }

    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(signed_checkpoint)?;
        self.write_to_bucket(
            S3Storage::checkpoint_key(signed_checkpoint.value.index),
            &serialized_checkpoint,
        )
        .await?;
        Ok(())
    }

    async fn write_metadata(&self, serialized_metadata: &str) -> Result<()> {
        self.write_to_bucket(S3Storage::metadata_key(), serialized_metadata)
            .await?;
        Ok(())
    }

    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        let serialized_announcement = serde_json::to_string_pretty(signed_announcement)?;
        self.write_to_bucket(S3Storage::announcement_key(), &serialized_announcement)
            .await?;
        Ok(())
    }

    fn announcement_location(&self) -> String {
        match self.folder.as_deref() {
            None | Some("") => format!("s3://{}/{}", self.bucket, self.region),
            Some(folder_str) => {
                format!("s3://{}/{}/{}", self.bucket, self.region, folder_str)
            }
        }
    }

    async fn write_reorg_status(&self, reorged_event: &ReorgEvent) -> Result<()> {
        let serialized_reorg = serde_json::to_string(reorged_event)?;
        self.write_to_bucket(S3Storage::reorg_flag_key(), &serialized_reorg)
            .await?;
        Ok(())
    }

    async fn reorg_status(&self) -> Result<Option<ReorgEvent>> {
        // Return None
        return Ok(None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_announcement_location() {
        // Test with a folder
        let s3_storage = S3Storage::new(
            "test-bucket".to_string(),
            Some("test-folder".to_string()),
            Region::new("us-east-1"),
            None,
        );
        let location = s3_storage.announcement_location();
        assert_eq!(location, "s3://test-bucket/us-east-1/test-folder");

        // Test without a folder
        let s3_storage = S3Storage::new(
            "test-bucket".to_string(),
            None,
            Region::new("us-east-1"),
            None,
        );
        let location = s3_storage.announcement_location();
        assert_eq!(location, "s3://test-bucket/us-east-1");
    }
}
