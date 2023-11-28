use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_core::{SignedAnnouncement, SignedCheckpointWithMessageId};
use prometheus::IntGauge;
use std::time::Duration;
use std::{fmt, sync::OnceLock};
use tokio::time::timeout;

use crate::{settings::gcp_client::GoogleCloudClientProvider, CheckpointSyncer};

const GCS_REQUEST_TIMEOUT_SECONDS: u64 = 30;

#[derive(Clone, new)]
/// Google Cloud Storage (GCS) type.
pub struct GCSStorage {
    /// The name of the bucket.
    bucket: String,

    /// A specific folder inside the above repo - set to empty string to use the root of the bucket
    folder: Option<String>,

    /// The region of the bucket.
    region: String,

    /// A client with GCS credentials.
    #[new(default)]
    authenticated_client: OnceLock<GoogleCloudClientProvider>,

    /// A client without credentials for anonymous requests.
    // #[new(default)]
    // anonymous_client: OnceLock<GoogleCloudClientProvider>,

    /// The latest seen signed checkpoint index.
    latest_index: Option<IntGauge>,
}

impl fmt::Debug for GCSStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GCSStorage")
            .field("bucket", &self.bucket)
            .field("folder", &self.folder)
            .field("region", &self.region)
            .finish()
    }
}

/// Implementation of GCSStorage.
impl GCSStorage {
    /// Write some data to a bucket.
    async fn write_to_bucket(&self, key: String, value: &str) -> Result<()> {
        let client = self.authenticated_client().await;

        timeout(
            Duration::from_secs(GCS_REQUEST_TIMEOUT_SECONDS),
            client.cli.object().create(
                self.bucket.clone().as_str(),
                value.clone().as_bytes().to_vec(),
                self.get_composite_key(key).as_str(),
                "application/json",
            ),
        )
        .await??;

        Ok(())
    }

    /// Uses an anonymous client. This should only be used for publicly accessible buckets.
    // async fn anonymously_read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
    //     let client = self.anonymous_client().await;

    //     let get_object_result = timeout(
    //         Duration::from_secs(GCS_REQUEST_TIMEOUT_SECONDS),
    //         client.cli.object().read(
    //             self.bucket.clone().as_str(),
    //             self.get_composite_key(key).as_str(),
    //         ),
    //     )
    //     .await?;

    //     match get_object_result {
    //         Ok(res) => {
    //             let body = res.download_url(GCS_REQUEST_TIMEOUT_SECONDS as u32)?;
    //             let bytes = body.into_bytes();
    //             Ok(Some(bytes))
    //         }
    //         Err(_) => Ok(None), // TODO: handle not 404 errors
    //     }
    // }

    /// Uses an authenticated client. This should only be used for private buckets.
    async fn authenticated_read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
        let client = self.authenticated_client().await;

        let get_object_result = timeout(
            Duration::from_secs(GCS_REQUEST_TIMEOUT_SECONDS),
            client.cli.object().read(
                self.bucket.clone().as_str(),
                self.get_composite_key(key).as_str(),
            ),
        )
        .await?;

        match get_object_result {
            Ok(res) => {
                let body = res.download_url(GCS_REQUEST_TIMEOUT_SECONDS as u32)?;
                let bytes = body.into_bytes();
                Ok(Some(bytes))
            }
            Err(_) => Ok(None), // TODO: handle not 404 errors
        }
    }

    /// Get an authenticated GCS client. Creating it if it doesn't already exist.
    async fn authenticated_client(&self) -> &GoogleCloudClientProvider {
        self.authenticated_client
            .get_or_init(GoogleCloudClientProvider::new_with_credentials)
    }

    /// Get an anonymous GCS client. Creating it if it doesn't already exist.
    // async fn anonymous_client(&self) -> &GoogleCloudClientProvider {
    //     self.anonymous_client
    //         .get_or_init(GoogleCloudClientProvider::new)
    // }

    fn get_composite_key(&self, key: String) -> String {
        match self.folder.as_deref() {
            None | Some("") => key,
            Some(folder_str) => format!("{}/{}", folder_str, key),
        }
    }

    /// Get the latest signed checkpoint index.
    fn checkpoint_key(index: u32) -> String {
        format!("checkpoint_{index}_with_id.json")
    }

    fn latest_index_key() -> String {
        "checkpoint_latest_index.json".to_owned()
    }

    fn announcement_key() -> String {
        "announcement.json".to_owned()
    }
}

#[async_trait]
impl CheckpointSyncer for GCSStorage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        let ret = self
            .authenticated_read_from_bucket(GCSStorage::latest_index_key())
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
        let serialized_index: String = serde_json::to_string(&index)?;
        self.write_to_bucket(GCSStorage::latest_index_key(), &serialized_index)
            .await?;
        Ok(())
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        self.authenticated_read_from_bucket(GCSStorage::checkpoint_key(index))
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
            GCSStorage::checkpoint_key(signed_checkpoint.value.index),
            &serialized_checkpoint,
        )
        .await?;
        Ok(())
    }

    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        let serialized_announcement = serde_json::to_string_pretty(signed_announcement)?;
        self.write_to_bucket(GCSStorage::announcement_key(), &serialized_announcement)
            .await?;
        Ok(())
    }

    fn announcement_location(&self) -> String {
        match self.folder.as_deref() {
            None | Some("") => format!("gcs://{}/{}", self.bucket, self.region.to_lowercase()),
            Some(folder_str) => {
                format!(
                    "gcs://{}/{}/{}",
                    self.bucket,
                    self.region.to_lowercase(),
                    folder_str
                )
            }
        }
    }
}
