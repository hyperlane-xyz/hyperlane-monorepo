use crate::CheckpointSyncer;
use async_trait::async_trait;
use derive_new::new;
use eyre::{bail, Result};
use hyperlane_core::{ReorgEvent, SignedAnnouncement, SignedCheckpointWithMessageId};
use std::fmt;
use tracing::{error, info, instrument};
use ya_gcp::{
    storage::{
        api::{error::HttpStatusError, http::StatusCode, Error},
        ObjectError, StorageClient,
    },
    AuthFlow, ClientBuilder, ClientBuilderConfig,
};

const LATEST_INDEX_KEY: &str = "gcsLatestIndexKey";
const METADATA_KEY: &str = "gcsMetadataKey";
const ANNOUNCEMENT_KEY: &str = "gcsAnnouncementKey";
const REORG_FLAG_KEY: &str = "gcsReorgFlagKey";

/// Path to GCS users_secret file
pub const GCS_USER_SECRET: &str = "GCS_USER_SECRET";
/// Path to GCS Service account key
pub const GCS_SERVICE_ACCOUNT_KEY: &str = "GCS_SERVICE_ACCOUNT_KEY";

/// Google Cloud Storage client builder
/// Provide `AuthFlow::NoAuth` for no-auth access to public bucket
/// # Example 1 - anonymous client with access to public bucket
/// ```
///    use hyperlane_base::GcsStorageClientBuilder;
///    use ya_gcp::AuthFlow;
/// #  #[tokio::main]
/// #  async fn main() {
///    let client = GcsStorageClientBuilder::new(AuthFlow::NoAuth)
///        .build("HyperlaneBucket", None)
///        .await.expect("failed to instantiate anonymous client");
/// #  }
///```
///
/// For authenticated write access to bucket proper file path must be provided.
/// # WARN: panic-s if file path is incorrect or data in it as faulty
///
/// # Example 2 - service account key
/// ```should_panic
///    use hyperlane_base::GcsStorageClientBuilder;
///    use ya_gcp::{AuthFlow, ServiceAccountAuth};
/// #  #[tokio::main]
/// #  async fn main() {
///    let auth =
///        AuthFlow::ServiceAccount(ServiceAccountAuth::Path("path/to/sac.json".into()));
///
///    let client = GcsStorageClientBuilder::new(auth)
///        .build("HyperlaneBucket", None)
///        .await.expect("failed to instantiate anonymous client");
/// #  }
///```
/// # Example 3 - user secret access
/// ```should_panic
///    use hyperlane_base::GcsStorageClientBuilder;
///    use ya_gcp::AuthFlow;
/// #  #[tokio::main]
/// #  async fn main() {
///    let auth =
///        AuthFlow::UserAccount("path/to/user_secret.json".into());
///
///    let client = GcsStorageClientBuilder::new(auth)
///        .build("HyperlaneBucket", None)
///        .await.expect("failed to instantiate anonymous client");
/// #  }
///```
#[derive(Debug, new)]
pub struct GcsStorageClientBuilder {
    auth: AuthFlow,
}

/// Google Cloud Storage client
/// Enables use of any of service account key OR user secrets to authenticate
/// For anonymous access to public data provide `(None, None)` to Builder
pub struct GcsStorageClient {
    // GCS storage client
    // # Details: <https://docs.rs/ya-gcp/latest/ya_gcp/storage/struct.StorageClient.html>
    inner: StorageClient,
    // bucket name of this client's storage
    bucket: String,
    // folder name of this client's storage
    folder: Option<String>,
}

impl GcsStorageClientBuilder {
    /// Instantiates `ya_gcp:StorageClient` based on provided auth method
    /// # Param
    /// * `bucket_name` - String name of target bucket to work with, will be used by all store and get ops
    pub async fn build(
        self,
        bucket_name: impl Into<String>,
        folder: Option<String>,
    ) -> Result<GcsStorageClient> {
        let inner = ClientBuilder::new(ClientBuilderConfig::new().auth_flow(self.auth))
            .await?
            .build_storage_client();

        let bucket = bucket_name.into();
        let mut processed_folder = folder;

        if let Some(ref mut folder_str) = processed_folder {
            if folder_str.ends_with('/') {
                folder_str.truncate(folder_str.trim_end_matches('/').len());
                info!(
                    "Trimmed trailing '/' from folder name. New folder: '{}'",
                    folder_str
                );
            }
        }

        GcsStorageClient::validate_bucket_name(&bucket)?;
        Ok(GcsStorageClient {
            inner,
            bucket,
            folder: processed_folder,
        })
    }
}

impl GcsStorageClient {
    // Convenience formatter
    fn get_checkpoint_key(index: u32) -> String {
        format!("checkpoint_{index}_with_id.json")
    }

    fn object_path(&self, object_name: &str) -> String {
        if let Some(folder) = &self.folder {
            format!("{}/{}", folder, object_name)
        } else {
            object_name.to_string()
        }
    }

    fn validate_bucket_name(bucket: &str) -> Result<()> {
        if bucket.contains('/') {
            error!("Bucket name '{}' has an invalid symbol '/'", bucket);
            bail!("Bucket name '{}' has an invalid symbol '/'", bucket)
        } else {
            Ok(())
        }
    }

    /// Uploads data to GCS and logs the result.
    #[instrument(skip(self, data))]
    async fn upload_and_log(&self, object_name: &str, data: Vec<u8>) -> Result<()> {
        match self
            .inner
            .insert_object(&self.bucket, object_name, data)
            .await
        {
            Ok(_) => {
                info!("Successfully uploaded to '{}'", object_name);
                Ok(())
            }
            Err(e) => {
                error!("Failed to upload to '{}': {:?}", object_name, e);
                Err(e.into())
            }
        }
    }

    // #test only method[s]
    #[cfg(test)]
    pub(crate) async fn get_by_path(&self, path: impl AsRef<str>) -> Result<()> {
        self.inner.get_object(&self.bucket, path).await?;
        Ok(())
    }
}

// Required by `CheckpointSyncer`
impl fmt::Debug for GcsStorageClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GcsStorageClient")
            .field("bucket", &self.bucket)
            .field("folder", &self.folder)
            .finish()
    }
}

#[async_trait]
impl CheckpointSyncer for GcsStorageClient {
    /// Read the highest index of this Syncer
    #[instrument(skip(self))]
    async fn latest_index(&self) -> Result<Option<u32>> {
        match self
            .inner
            .get_object(&self.bucket, &(self.object_path(LATEST_INDEX_KEY)))
            .await
        {
            Ok(data) => Ok(Some(serde_json::from_slice(data.as_ref())?)),
            Err(e) => match e {
                // never written before to this bucket
                ObjectError::InvalidName(_) => Ok(None),
                ObjectError::Failure(Error::HttpStatus(HttpStatusError(StatusCode::NOT_FOUND))) => {
                    Ok(None)
                }
                _ => bail!(e),
            },
        }
    }

    /// Writes the highest index of this Syncer
    #[instrument(skip(self, index))]
    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let data = serde_json::to_vec(&index)?;
        self.upload_and_log(&(self.object_path(LATEST_INDEX_KEY)), data)
            .await
    }

    /// Attempt to fetch the signed (checkpoint, messageId) tuple at this index
    #[instrument(skip(self, index))]
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let checkpoint_key = GcsStorageClient::get_checkpoint_key(index);
        match self
            .inner
            .get_object(&self.bucket, &(self.object_path(&checkpoint_key)))
            .await
        {
            Ok(data) => Ok(Some(serde_json::from_slice(data.as_ref())?)),
            Err(e) => match e {
                ObjectError::Failure(Error::HttpStatus(HttpStatusError(StatusCode::NOT_FOUND))) => {
                    Ok(None)
                }
                _ => bail!(e),
            },
        }
    }

    /// Write the signed (checkpoint, messageId) tuple to this syncer
    #[instrument(skip(self, signed_checkpoint))]
    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        let object_key = Self::get_checkpoint_key(signed_checkpoint.value.index);
        let object_name = self.object_path(&object_key);
        let data = serde_json::to_vec(signed_checkpoint)?;
        self.upload_and_log(&object_name, data).await
    }

    /// Write the agent metadata to this syncer
    #[instrument(skip(self, serialized_metadata))]
    async fn write_metadata(&self, serialized_metadata: &str) -> Result<()> {
        let object_name = self.object_path(METADATA_KEY);
        let data = serialized_metadata.to_owned().into_bytes();
        self.upload_and_log(&object_name, data).await
    }

    /// Write the signed announcement to this syncer
    #[instrument(skip(self, announcement))]
    async fn write_announcement(&self, announcement: &SignedAnnouncement) -> Result<()> {
        let object_name = self.object_path(ANNOUNCEMENT_KEY);
        let data = serde_json::to_string(announcement)?.into_bytes();
        self.upload_and_log(&object_name, data).await
    }

    /// Return the announcement storage location for this syncer
    #[instrument(skip(self))]
    fn announcement_location(&self) -> String {
        let location = format!(
            "gs://{}/{}",
            &self.bucket,
            self.object_path(ANNOUNCEMENT_KEY)
        );
        info!("Announcement storage location: '{}'", location);
        location
    }

    /// Write the reorg status to this syncer
    #[instrument(skip(self, reorg_event))]
    async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> Result<()> {
        let data = serde_json::to_string_pretty(reorg_event)?.into_bytes();
        self.upload_and_log(&(self.object_path(REORG_FLAG_KEY)), data)
            .await
    }

    /// Read the reorg status from this syncer
    #[instrument(skip(self))]
    async fn reorg_status(&self) -> Result<Option<ReorgEvent>> {
        match self
            .inner
            .get_object(&self.bucket, &(self.object_path(REORG_FLAG_KEY)))
            .await
        {
            Ok(data) => Ok(Some(serde_json::from_slice(data.as_ref())?)),
            Err(e) => match e {
                ObjectError::Failure(Error::HttpStatus(HttpStatusError(StatusCode::NOT_FOUND))) => {
                    Ok(None)
                }
                _ => bail!(e),
            },
        }
    }
}

#[tokio::test]
async fn public_landset_no_auth_works_test() {
    const LANDSAT_BUCKET: &str = "gcp-public-data-landsat";
    const LANDSAT_KEY: &str = "LC08/01/001/003/LC08_L1GT_001003_20140812_20170420_01_T2/LC08_L1GT_001003_20140812_20170420_01_T2_B3.TIF";
    let client = GcsStorageClientBuilder::new(AuthFlow::NoAuth)
        .build(LANDSAT_BUCKET, None)
        .await
        .unwrap();
    assert!(client.get_by_path(LANDSAT_KEY).await.is_ok());
}
