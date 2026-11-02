use crate::CheckpointSyncer;
use async_trait::async_trait;
use derive_new::new;
use eyre::{bail, ensure, Result};
use hyperlane_core::accumulator::incremental::MerkleTreeSnapshot;
use hyperlane_core::{
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId,
};
use std::fmt;
use tracing::{error, info, instrument};
use ya_gcp::AuthFlow;

mod client;
use client::StorageClient;

// A depth-32 frontier serializes to < 5 KiB of JSON even at the largest index.
// Keep its bound separate from ordinary checkpoint and error responses.
const MAX_MERKLE_SNAPSHOT_SIZE: usize = 8 * 1024;
const MERKLE_SNAPSHOT_KEY: &str = "merkle_snapshot.json";
const LATEST_INDEX_KEY: &str = "gcsLatestIndexKey";
const METADATA_KEY: &str = "gcsMetadataKey";
const ANNOUNCEMENT_KEY: &str = "gcsAnnouncementKey";
const REORG_FLAG_KEY: &str = "gcsReorgFlagKey";
const REORG_RPC_RESPONSES_KEY: &str = "gcsReorgRpcResponsesKey";

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
    // Authenticated, bounded GCS storage transport
    inner: StorageClient,
    // bucket name of this client's storage
    bucket: String,
    // folder name of this client's storage
    folder: Option<String>,
}

impl GcsStorageClientBuilder {
    /// Instantiates the bounded GCS transport with the provided auth method
    /// # Param
    /// * `bucket_name` - String name of target bucket to work with, will be used by all store and get ops
    pub async fn build(
        self,
        bucket_name: impl Into<String>,
        folder: Option<String>,
    ) -> Result<GcsStorageClient> {
        let inner = StorageClient::new(self.auth).await?;

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
            format!("{folder}/{object_name}")
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
                Err(e)
            }
        }
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
    async fn read_merkle_snapshot(&self) -> Result<Option<MerkleTreeSnapshot>> {
        self.inner
            .get_object_with_limit(
                &self.bucket,
                &self.object_path(MERKLE_SNAPSHOT_KEY),
                MAX_MERKLE_SNAPSHOT_SIZE,
            )
            .await?
            .map(|data| serde_json::from_slice(&data).map_err(Into::into))
            .transpose()
    }

    async fn write_merkle_snapshot(&self, snapshot: &MerkleTreeSnapshot) -> Result<()> {
        let data = serde_json::to_vec(snapshot)?;
        ensure!(
            data.len() < MAX_MERKLE_SNAPSHOT_SIZE,
            "Merkle snapshot exceeds GCS snapshot size limit"
        );
        self.upload_and_log(&self.object_path(MERKLE_SNAPSHOT_KEY), data)
            .await
    }

    /// Read the highest index of this Syncer
    #[instrument(skip(self))]
    async fn latest_index(&self) -> Result<Option<u32>> {
        self.inner
            .get_object(&self.bucket, &self.object_path(LATEST_INDEX_KEY))
            .await?
            .map(|data| serde_json::from_slice(&data).map_err(Into::into))
            .transpose()
    }

    /// Writes the highest index of this Syncer
    #[instrument(skip(self, index))]
    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let data = serde_json::to_vec(&index)?;
        self.upload_and_log(&self.object_path(LATEST_INDEX_KEY), data)
            .await
    }

    /// Attempt to fetch the signed (checkpoint, messageId) tuple at this index
    #[instrument(skip(self, index))]
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        self.inner
            .get_object(
                &self.bucket,
                &self.object_path(&GcsStorageClient::get_checkpoint_key(index)),
            )
            .await?
            .map(|data| serde_json::from_slice(&data).map_err(Into::into))
            .transpose()
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
        let object_name = self.object_path(REORG_FLAG_KEY);
        let data = serde_json::to_string_pretty(reorg_event)?.into_bytes();
        self.upload_and_log(&object_name, data).await
    }

    #[instrument(skip(self, log))]
    async fn write_reorg_rpc_responses(&self, log: String) -> Result<()> {
        let object_name = self.object_path(REORG_RPC_RESPONSES_KEY);
        self.upload_and_log(&object_name, log.into_bytes()).await
    }

    /// Read the reorg status from this syncer
    #[instrument(skip(self))]
    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        // A validator run before folder-scoping existed (or one running an
        // older binary against this same bucket) would have written its
        // reorg flag at the bucket root regardless of `folder`. Check there
        // too and treat it as authoritative if present — silently only
        // checking the folder-scoped path could let a legacy root-level
        // reorg flag go unseen and signing resume through an unresolved reorg.
        if self.folder.is_some() {
            let root_status = self.fetch_reorg_status_at(REORG_FLAG_KEY).await?;
            if root_status.exists {
                return Ok(root_status);
            }
        }
        self.fetch_reorg_status_at(&self.object_path(REORG_FLAG_KEY))
            .await
    }
}

impl GcsStorageClient {
    async fn fetch_reorg_status_at(&self, key: &str) -> Result<ReorgEventResponse> {
        let Some(object) = self.inner.get_object(&self.bucket, key).await? else {
            return Ok(ReorgEventResponse {
                exists: false,
                event: None,
                content: None,
            });
        };
        match serde_json::from_slice(&object) {
            Ok(s) => Ok(ReorgEventResponse {
                exists: true,
                event: Some(s),
                content: Some(String::from_utf8_lossy(&object).to_string()),
            }),
            Err(err) => {
                error!(?err, "Failed to parse reorg event");
                Ok(ReorgEventResponse {
                    exists: true,
                    event: None,
                    content: Some(String::from_utf8_lossy(&object).to_string()),
                })
            }
        }
    }
}

#[tokio::test]
async fn object_path_prefixes_every_key_with_the_folder() {
    let client = GcsStorageClientBuilder::new(AuthFlow::NoAuth)
        .build("test-bucket", Some("sepolia".to_string()))
        .await
        .unwrap();

    // Every syncer key must be scoped under the folder — otherwise validators
    // sharing a bucket across chains via folder prefixes silently collide,
    // and a write under the folder is unreadable by a read that isn't scoped.
    assert_eq!(
        client.object_path(MERKLE_SNAPSHOT_KEY),
        "sepolia/merkle_snapshot.json"
    );
    assert_eq!(
        client.object_path(LATEST_INDEX_KEY),
        "sepolia/gcsLatestIndexKey"
    );
    assert_eq!(
        client.object_path(&GcsStorageClient::get_checkpoint_key(5)),
        "sepolia/checkpoint_5_with_id.json"
    );
    assert_eq!(
        client.object_path(REORG_FLAG_KEY),
        "sepolia/gcsReorgFlagKey"
    );
    assert_eq!(
        client.announcement_location(),
        "gs://test-bucket/sepolia/gcsAnnouncementKey"
    );
}

#[tokio::test]
async fn object_path_is_unprefixed_without_a_folder() {
    let client = GcsStorageClientBuilder::new(AuthFlow::NoAuth)
        .build("test-bucket", None)
        .await
        .unwrap();

    assert_eq!(client.object_path(LATEST_INDEX_KEY), LATEST_INDEX_KEY);
    assert_eq!(
        client.announcement_location(),
        "gs://test-bucket/gcsAnnouncementKey"
    );
}

#[test]
fn snapshot_frontier_fits_dedicated_cap_at_maximum_supported_count() {
    use hyperlane_core::{accumulator::incremental::IncrementalMerkle, H256};
    // All byte values are 255: worst-case JSON width for the fixed frontier.
    let tree = IncrementalMerkle::new([H256::repeat_byte(255); 32], u32::MAX as usize);
    let snapshot = MerkleTreeSnapshot::capture(&tree).unwrap();
    let data = serde_json::to_vec(&snapshot).unwrap();
    println!(
        "maximum supported count snapshot JSON bytes: {}",
        data.len()
    );
    assert!(data.len() < MAX_MERKLE_SNAPSHOT_SIZE);
    assert_eq!(snapshot.restore().unwrap().root(), tree.root());
}
