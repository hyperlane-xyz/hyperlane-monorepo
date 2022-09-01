use std::fmt;

use abacus_core::SignedCheckpoint;
use async_trait::async_trait;
use eyre::{bail, Result};
use futures_util::TryStreamExt;
use prometheus::IntGauge;
use rusoto_core::{credential::EnvironmentProvider, HttpClient, Region, RusotoError};
use rusoto_s3::{GetObjectError, GetObjectRequest, PutObjectRequest, S3Client, S3};

use crate::CheckpointSyncer;

#[derive(Clone)]
/// Type for reading/writing to S3
pub struct S3Storage {
    /// bucket
    bucket: String,
    /// region
    region: Region,
    /// client
    client: S3Client,
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
    /// constructor
    pub fn new(bucket: &str, region: Region, latest_index: Option<IntGauge>) -> Self {
        let client = S3Client::new_with(
            HttpClient::new().unwrap(),
            EnvironmentProvider::default(),
            region.clone(),
        );

        Self {
            bucket: bucket.to_owned(),
            region,
            client,
            latest_index,
        }
    }

    async fn write_to_bucket(&self, key: String, body: &str) -> Result<()> {
        let req = PutObjectRequest {
            key,
            bucket: self.bucket.clone(),
            body: Some(Vec::from(body).into()),
            content_type: Some("application/json".to_owned()),
            ..Default::default()
        };
        self.client.put_object(req).await?;
        Ok(())
    }

    async fn read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
        let req = GetObjectRequest {
            key,
            bucket: self.bucket.clone(),
            ..Default::default()
        };
        match self.client.get_object(req).await {
            Ok(res) => match res.body {
                Some(body) => Ok(Some(body.map_ok(|b| b.to_vec()).try_concat().await?)),
                None => Ok(None),
            },
            Err(RusotoError::Service(GetObjectError::NoSuchKey(_))) => Ok(None),
            Err(e) => bail!(e),
        }
    }

    fn checkpoint_key(index: u32) -> String {
        format!("checkpoint_{}.json", index)
    }
    fn index_key() -> String {
        "checkpoint_latest_index.json".to_owned()
    }
}

#[async_trait]
impl CheckpointSyncer for S3Storage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        let ret = self
            .read_from_bucket(S3Storage::index_key())
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
        self.read_from_bucket(S3Storage::checkpoint_key(index))
            .await?
            .map(|data| serde_json::from_slice(&data))
            .transpose()
            .map_err(Into::into)
    }
    async fn write_checkpoint(&self, signed_checkpoint: SignedCheckpoint) -> Result<()> {
        let serialized_checkpoint = serde_json::to_string_pretty(&signed_checkpoint)?;
        self.write_to_bucket(
            S3Storage::checkpoint_key(signed_checkpoint.checkpoint.index),
            &serialized_checkpoint,
        )
        .await?;

        self.write_to_bucket(
            S3Storage::index_key(),
            &signed_checkpoint.checkpoint.index.to_string(),
        )
        .await?;
        Ok(())
    }
}
