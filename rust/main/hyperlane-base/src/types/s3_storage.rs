use std::{fmt, sync::OnceLock, time::Duration};

use async_trait::async_trait;
use aws_config::{timeout::TimeoutConfig, BehaviorVersion, ConfigLoader, Region};
use aws_sdk_s3::{
    error::SdkError, operation::get_object::GetObjectError as SdkGetObjectError,
    primitives::ByteStream, Client,
};
use dashmap::DashMap;
use derive_new::new;
use eyre::{bail, Result};
use prometheus::IntGauge;
use tokio::sync::OnceCell;
use tracing::error;

use hyperlane_core::{
    ReorgEvent, ReorgEventResponse, SignedAnnouncement, SignedCheckpointWithMessageId,
};

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

/// Reads a `ByteStream` chunk by chunk, aborting as soon as the cumulative size reaches
/// `S3_MAX_OBJECT_SIZE` - enforced against bytes actually received, not a `Content-Length`
/// header, since an adversarial or misconfigured object store isn't obligated to report an
/// accurate size.
async fn read_capped(mut body: ByteStream, key: &str) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    while let Some(chunk) = body.try_next().await? {
        buf.extend_from_slice(&chunk);
        if buf.len() as i64 >= S3_MAX_OBJECT_SIZE {
            bail!(
                "Object size for key {key} exceeds the {}KiB limit",
                S3_MAX_OBJECT_SIZE / 1024
            );
        }
    }
    Ok(buf)
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

    async fn anonymously_read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
        let get_object_result = self
            .anonymous_client()
            .await
            .get_object()
            .bucket(self.bucket.clone())
            .key(self.get_composite_key(key.clone()))
            .send()
            .await;
        let body = match get_object_result {
            Ok(res) => res.body,
            Err(SdkError::ServiceError(err)) => match err.err() {
                SdkGetObjectError::NoSuchKey(_) => return Ok(None),
                _ => bail!(err.into_err()),
            },
            Err(e) => bail!(e),
        };
        Ok(Some(read_capped(body, &key).await?))
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
            Some(folder_str) => format!("{folder_str}/{key}"),
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

    fn reorg_rpc_responses_key() -> String {
        "reorg_rpc_responses.json".to_owned()
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

    async fn write_reorg_rpc_responses(&self, reorg_log: String) -> Result<()> {
        self.write_to_bucket(S3Storage::reorg_rpc_responses_key(), &reorg_log)
            .await?;
        Ok(())
    }

    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        let file = self
            .anonymously_read_from_bucket(S3Storage::reorg_flag_key())
            .await?;

        let contents = match file {
            Some(s) => s,
            None => {
                return Ok(ReorgEventResponse {
                    exists: false,
                    event: None,
                    content: None,
                })
            }
        };
        match serde_json::from_slice(&contents) {
            Ok(s) => Ok(ReorgEventResponse {
                exists: true,
                event: Some(s),
                content: Some(String::from_utf8_lossy(&contents).to_string()),
            }),
            Err(err) => {
                error!(?err, "Failed to parse reorg event");
                Ok(ReorgEventResponse {
                    exists: true,
                    event: None,
                    content: Some(String::from_utf8_lossy(&contents).to_string()),
                })
            }
        }
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

    #[tokio::test]
    async fn read_capped_allows_body_under_limit() {
        let data = vec![7u8; 1024];
        let body = ByteStream::new(aws_sdk_s3::primitives::SdkBody::from(data.clone()));
        let result = read_capped(body, "small-object")
            .await
            .expect("body under the cap must be read successfully");
        assert_eq!(result, data);
    }

    #[tokio::test]
    async fn read_capped_rejects_oversized_body() {
        // One byte over the cap - the object store claiming a small size isn't
        // relevant here, since read_capped never looks at any header, only bytes
        // actually streamed.
        let data = vec![7u8; (S3_MAX_OBJECT_SIZE + 1) as usize];
        let body = ByteStream::new(aws_sdk_s3::primitives::SdkBody::from(data));
        let err = read_capped(body, "huge-object")
            .await
            .expect_err("oversized body must be rejected");
        assert!(err.to_string().contains("exceeds"));
    }

    /// Proves the abort happens mid-transfer, not just on the buffered result: a local server
    /// declares a 1GiB body and streams for as long as the client keeps reading, and this
    /// asserts the client disconnects after only a small multiple of the 50KiB cap.
    #[tokio::test]
    async fn anonymously_read_from_bucket_aborts_download_of_oversized_object() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binding a loopback listener must succeed");
        let addr = listener
            .local_addr()
            .expect("a bound listener must have a local address");

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener
                .accept()
                .await
                .expect("the test client must connect");

            // Read until the end of the request headers - the connection stays open
            // afterwards (the client is waiting on a response), so EOF never comes.
            let mut discard = [0u8; 4096];
            loop {
                let n = socket
                    .read(&mut discard)
                    .await
                    .expect("reading the request must succeed");
                if discard[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }

            let declared_size = 1024 * 1024 * 1024u64; // 1GiB, never actually sent in full
            socket
                .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {declared_size}\r\nConnection: close\r\n\r\n").as_bytes())
                .await
                .expect("writing response headers must succeed");

            let chunk = [7u8; 8 * 1024];
            let mut total_written = 0usize;
            while socket.write_all(&chunk).await.is_ok() {
                total_written += chunk.len();
            }
            total_written
        });

        // A plain HTTP-only connector - this test's endpoint is unencrypted `http://`, and
        // building one explicitly avoids the SDK's default TLS-capable connector, which eagerly
        // loads the OS certificate store even when it'll never be used for a plain-http request.
        let http_client = aws_smithy_http_client::hyper_014::HyperClientBuilder::new()
            .build(hyper::client::HttpConnector::new());
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(aws_config::BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .endpoint_url(format!("http://{addr}"))
            .force_path_style(true)
            .http_client(http_client)
            .credentials_provider(aws_sdk_s3::config::Credentials::for_tests())
            .build();

        let res = Client::from_conf(config)
            .get_object()
            .bucket("test-bucket")
            .key("huge-object")
            .send()
            .await
            .expect("fake server always returns 200");
        let err = read_capped(res.body, "huge-object")
            .await
            .expect_err("oversized body must be rejected");
        assert!(err.to_string().contains("exceeds"));

        let total_written = server.await.expect("the mock server task must not panic");
        assert!(
            total_written < 2 * 1024 * 1024,
            "server was allowed to stream {total_written} bytes before the client disconnected - \
             the download is not actually being aborted mid-transfer"
        );
    }
}
