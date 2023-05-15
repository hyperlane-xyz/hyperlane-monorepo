use std::{fmt, time::Duration};

use async_trait::async_trait;
use derive_new::new;
use eyre::{bail, Result};
use futures_util::TryStreamExt;
use once_cell::sync::OnceCell;
use prometheus::IntGauge;
use rusoto_core::{
    credential::{Anonymous, AwsCredentials, EnvironmentProvider, StaticProvider},
    HttpClient, Region, RusotoError,
};
use rusoto_s3::{GetObjectError, GetObjectRequest, PutObjectRequest, S3Client, S3};
use tokio::time::timeout;

use hyperlane_core::{SignedAnnouncement, SignedCheckpoint, SignedCheckpointWithMessageId};

use crate::CheckpointSyncer;

/// The timeout for S3 requests. Rusoto doesn't offer timeout configuration
/// out of the box, so S3 requests must be wrapped with a timeout.
/// See https://github.com/rusoto/rusoto/issues/1795.
const S3_REQUEST_TIMEOUT_SECONDS: u64 = 30;

#[derive(Clone, new)]
/// Type for reading/writing to S3
pub struct S3Storage {
    /// The name of the bucket.
    bucket: String,
    /// The region of the bucket.
    region: Region,
    /// A client with AWS credentials.
    #[new(default)]
    authenticated_client: OnceCell<S3Client>,
    /// A client without credentials for anonymous requests.
    #[new(default)]
    anonymous_client: OnceCell<S3Client>,
    /// The latest seen signed checkpoint index.
    latest_index: Option<IntGauge>,
}

impl fmt::Debug for S3Storage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Storage")
            .field("bucket", &self.bucket)
            .field("region", &self.region)
            .finish()
    }
}

impl S3Storage {
    async fn write_to_bucket(&self, key: String, body: &str) -> Result<()> {
        let req = PutObjectRequest {
            key,
            bucket: self.bucket.clone(),
            body: Some(Vec::from(body).into()),
            content_type: Some("application/json".to_owned()),
            ..Default::default()
        };
        timeout(
            Duration::from_secs(S3_REQUEST_TIMEOUT_SECONDS),
            self.authenticated_client().put_object(req),
        )
        .await??;
        Ok(())
    }

    /// Uses an anonymous client. This should only be used for publicly accessible buckets.
    async fn anonymously_read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
        let req = GetObjectRequest {
            key,
            bucket: self.bucket.clone(),
            ..Default::default()
        };
        let get_object_result = timeout(
            Duration::from_secs(S3_REQUEST_TIMEOUT_SECONDS),
            self.anonymous_client().get_object(req),
        )
        .await?;

        match get_object_result {
            Ok(res) => match res.body {
                Some(body) => Ok(Some(body.map_ok(|b| b.to_vec()).try_concat().await?)),
                None => Ok(None),
            },
            Err(RusotoError::Service(GetObjectError::NoSuchKey(_))) => Ok(None),
            Err(e) => bail!(e),
        }
    }

    /// Gets an authenticated S3Client, creating it if it doesn't already exist.
    fn authenticated_client(&self) -> &S3Client {
        self.authenticated_client.get_or_init(|| {
            S3Client::new_with(
                HttpClient::new().unwrap(),
                EnvironmentProvider::default(),
                self.region.clone(),
            )
        })
    }

    /// Gets an anonymous S3Client, creating it if it doesn't already exist.
    /// An anonymous client doesn't have AWS credentials and will not sign S3
    /// requests with any credentials.
    /// We've experienced an inability to make GetObjectRequests to public
    /// S3 buckets when signing with credentials from an AWS account not from the
    /// S3 bucket's AWS account.
    fn anonymous_client(&self) -> &S3Client {
        self.anonymous_client.get_or_init(|| {
            // By default, these credentials are anonymous, see https://docs.rs/rusoto_credential/latest/rusoto_credential/struct.AwsCredentials.html#anonymous-example
            let credentials = AwsCredentials::default();
            assert!(credentials.is_anonymous(), "AWS credentials not anonymous");

            S3Client::new_with(
                HttpClient::new().unwrap(),
                StaticProvider::from(credentials),
                self.region.clone(),
            )
        })
    }

    fn checkpoint_key(index: u32) -> String {
        format!("checkpoint_{}.json", index)
    }

    fn checkpoint_with_id_key(index: u32) -> String {
        format!("checkpoint_{}_with_id.json", index)
    }

    fn index_key() -> String {
        "checkpoint_latest_index.json".to_owned()
    }

    fn announcement_key() -> String {
        "announcement.json".to_owned()
    }
}

#[async_trait]
impl CheckpointSyncer for S3Storage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        let ret = self
            .anonymously_read_from_bucket(S3Storage::index_key())
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

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpoint>> {
        self.anonymously_read_from_bucket(S3Storage::checkpoint_key(index))
            .await?
            .map(|data| serde_json::from_slice(&data))
            .transpose()
            .map_err(Into::into)
    }

    async fn fetch_checkpoint_with_message_id(
        &self,
        index: u32,
    ) -> Result<Option<SignedCheckpointWithMessageId>> {
        self.anonymously_read_from_bucket(S3Storage::checkpoint_with_id_key(index))
            .await?
            .map(|data| serde_json::from_slice(&data))
            .transpose()
            .map_err(Into::into)
    }

    async fn write_checkpoint(&self, signed_checkpoint: &SignedCheckpoint) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(signed_checkpoint)?;
        self.write_to_bucket(
            S3Storage::checkpoint_key(signed_checkpoint.value.index),
            &serialized_checkpoint,
        )
        .await?;

        self.write_to_bucket(
            S3Storage::index_key(),
            &signed_checkpoint.value.index.to_string(),
        )
        .await?;
        Ok(())
    }

    async fn write_checkpoint_with_message_id(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(signed_checkpoint)?;
        self.write_to_bucket(
            S3Storage::checkpoint_with_id_key(signed_checkpoint.value.index),
            &serialized_checkpoint,
        )
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
        format!("s3://{}/{}", self.bucket, self.region.name())
    }
}
