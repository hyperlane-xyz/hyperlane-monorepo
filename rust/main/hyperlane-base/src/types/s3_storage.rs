use std::{
    env,
    error::Error,
    fmt,
    future::Future,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    pin::Pin,
    sync::OnceLock,
    task::{Context, Poll},
    time::Duration,
};

use async_trait::async_trait;
use aws_config::{timeout::TimeoutConfig, BehaviorVersion, ConfigLoader, Region, SdkConfig};
use aws_sdk_s3::{
    config::{Credentials, SharedCredentialsProvider},
    error::SdkError,
    operation::get_object::GetObjectError as SdkGetObjectError,
    primitives::ByteStream,
    Client,
};
use aws_smithy_http_client::hyper_014::HyperClientBuilder;
use dashmap::DashMap;
use derive_new::new;
use eyre::{bail, Result};
use hyper::{
    client::connect::dns::{GaiResolver, Name},
    service::Service,
};
use hyper_rustls::HttpsConnectorBuilder;
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
const AWS_ENDPOINT_URL_S3: &str = "AWS_ENDPOINT_URL_S3";

/// Credentials scoped to a single S3-compatible checkpoint syncer.
#[derive(Clone)]
pub struct S3Credentials {
    /// S3 access key ID.
    pub access_key_id: String,
    /// S3 secret access key.
    pub secret_access_key: String,
}

impl fmt::Debug for S3Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("S3Credentials")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .finish()
    }
}

/// Optional settings for an S3-compatible checkpoint syncer client.
#[derive(Clone, Debug, Default)]
pub struct S3ClientConfig {
    /// Custom S3-compatible endpoint.
    pub endpoint: Option<String>,
    /// Whether to force path-style bucket addressing.
    pub force_path_style: Option<bool>,
    /// Credentials scoped to this S3 client.
    pub credentials: Option<S3Credentials>,
    /// Whether the endpoint came from an untrusted validator announcement.
    pub endpoint_is_announced: bool,
}

#[derive(Clone, new)]
/// Type for reading/writing to S3
pub struct S3Storage {
    /// The name of the bucket.
    bucket: String,
    /// A specific folder inside the above repo - set to empty string to use the root of the bucket
    folder: Option<String>,
    /// The region of the bucket.
    region: Region,
    /// Optional client settings for S3-compatible object stores.
    client_config: S3ClientConfig,
    /// A client with AWS credentials. This client is not initialized globally and has a lifetime
    /// tied to the S3Storage instance, so if heavy use of this client is expected, S3Storage
    /// itself should be long-lived.
    #[new(default)]
    authenticated_client: OnceCell<Client>,
    /// The latest seen signed checkpoint index.
    latest_index: Option<IntGauge>,
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct AnonymousClientCacheKey {
    region: Region,
    endpoint: Option<String>,
    force_path_style: Option<bool>,
    endpoint_is_announced: bool,
}

/// A global cache of anonymous S3 clients, per endpoint configuration.
/// We've seen freshly created S3 clients make expensive DNS / TCP
/// requests when creating them. This cache allows us to reuse
/// anonymous clients across the entire agent.
static ANONYMOUS_CLIENT_CACHE: OnceLock<DashMap<AnonymousClientCacheKey, OnceCell<Client>>> =
    OnceLock::new();

fn get_anonymous_client_cache() -> &'static DashMap<AnonymousClientCacheKey, OnceCell<Client>> {
    ANONYMOUS_CLIENT_CACHE.get_or_init(DashMap::new)
}

type ResolverError = Box<dyn Error + Send + Sync>;
type ResolverFuture =
    Pin<Box<dyn Future<Output = Result<std::vec::IntoIter<SocketAddr>, ResolverError>> + Send>>;

/// DNS resolver used for announcement-controlled endpoints. It validates every
/// answer immediately before returning it to the connector, so the connection
/// uses the exact addresses that passed the public-IP check.
#[derive(Clone, Debug)]
struct PublicDnsResolver<R = GaiResolver> {
    inner: R,
}

impl Default for PublicDnsResolver<GaiResolver> {
    fn default() -> Self {
        Self {
            inner: GaiResolver::new(),
        }
    }
}

impl<R> Service<Name> for PublicDnsResolver<R>
where
    R: Service<Name> + Clone + Send + 'static,
    R::Response: Iterator<Item = SocketAddr> + Send + 'static,
    R::Future: Send + 'static,
    R::Error: Error + Send + Sync + 'static,
{
    type Response = std::vec::IntoIter<SocketAddr>;
    type Error = ResolverError;
    type Future = ResolverFuture;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, name: Name) -> Self::Future {
        let host = name.as_str().to_owned();
        let mut inner = self.inner.clone();
        Box::pin(async move {
            let addrs = inner
                .call(name)
                .await
                .map_err(|err| Box::new(err) as ResolverError)?;
            validate_resolved_addrs(&host, addrs).map(Vec::into_iter)
        })
    }
}

fn validate_resolved_addrs(
    host: &str,
    addrs: impl IntoIterator<Item = SocketAddr>,
) -> Result<Vec<SocketAddr>, ResolverError> {
    let addrs: Vec<_> = addrs.into_iter().collect();
    if addrs.is_empty() {
        return Err(format!("Announced S3 endpoint {host} resolved to no addresses").into());
    }
    if let Some(address) = addrs.iter().find(|addr| !is_public_ip(addr.ip())) {
        return Err(format!(
            "Announced S3 endpoint {host} resolved to non-public address {}",
            address.ip()
        )
        .into());
    }
    Ok(addrs)
}

/// Returns whether an IP is globally routable enough for an untrusted HTTP
/// destination. This mirrors the relayer's CCIP-read SSRF policy.
pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !matches!(
        (a, b, c),
        (0, _, _)
            | (10, _, _)
            | (100, 64..=127, _)
            | (127, _, _)
            | (169, 254, _)
            | (172, 16..=31, _)
            | (192, 0, 0)
            | (192, 0, 2)
            | (192, 88, 99)
            | (192, 168, _)
            | (198, 18..=19, _)
            | (198, 51, 100)
            | (203, 0, 113)
            | (224..=255, _, _)
    )
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    let octets = ip.octets();
    if let Some(embedded) = ip.to_ipv4() {
        return is_public_ipv4(embedded);
    }

    octets[0] & 0xe0 == 0x20
        && !((octets[0] == 0x20 && octets[1] == 0x01 && matches!(octets[2], 0x00 | 0x02))
            || (octets[0] == 0x20 && octets[1] == 0x01 && octets[2] == 0x0d && octets[3] == 0xb8)
            || (octets[0] == 0x20 && octets[1] == 0x02)
            || (octets[0] == 0x3f && octets[1] == 0xff && octets[2] & 0xf0 == 0))
}

/// Reads a `ByteStream` chunk by chunk, aborting as soon as the cumulative size reaches
/// `S3_MAX_OBJECT_SIZE` - enforced against bytes actually received, not a `Content-Length`
/// header, since an adversarial or misconfigured object store isn't obligated to report an
/// accurate size.
///
/// Bounded by `timeout`: the SDK's own operation timeout only covers request transmission and
/// response headers, not this body read, so a connection that stalls (or drips bytes just under
/// the size cap) after headers are received would otherwise hang indefinitely.
async fn read_capped_with_timeout(
    mut body: ByteStream,
    key: &str,
    timeout: Duration,
) -> Result<Vec<u8>> {
    tokio::time::timeout(timeout, async {
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
    })
    .await
    .map_err(|_| eyre::eyre!("Timed out reading object for key {key} after {timeout:?}"))?
}

async fn read_capped(body: ByteStream, key: &str) -> Result<Vec<u8>> {
    read_capped_with_timeout(body, key, S3_REQUEST_TIMEOUT).await
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

    async fn read_from_bucket(&self, key: String) -> Result<Option<Vec<u8>>> {
        let client = if self.client_config.credentials.is_some() {
            self.authenticated_client().await.clone()
        } else {
            self.anonymous_client().await
        };
        let get_object_result = client
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
                let endpoint = self.resolved_endpoint();
                self.client_from_sdk_config(
                    &config,
                    endpoint.as_deref(),
                    self.client_config.endpoint_is_announced,
                )
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
        let endpoint = self.resolved_endpoint();
        let cache_key = AnonymousClientCacheKey {
            region: self.region.clone(),
            endpoint: endpoint.clone(),
            force_path_style: self.client_config.force_path_style,
            endpoint_is_announced: self.client_config.endpoint_is_announced,
        };
        let cell = get_anonymous_client_cache().entry(cache_key).or_default();

        cell.get_or_init(|| async {
            let config = self
                .default_aws_sdk_config_loader()
                // Make anonymous, important to not require AWS credentials
                // to operate the relayer
                .no_credentials()
                .load()
                .await;
            self.client_from_sdk_config(
                &config,
                endpoint.as_deref(),
                self.client_config.endpoint_is_announced,
            )
        })
        .await
        .clone()
    }

    fn client_from_sdk_config(
        &self,
        config: &SdkConfig,
        endpoint: Option<&str>,
        protect_endpoint: bool,
    ) -> Client {
        let mut builder = aws_sdk_s3::config::Builder::from(config);
        if let Some(endpoint) = endpoint {
            builder = builder.endpoint_url(endpoint);
        }
        if let Some(force_path_style) = self.client_config.force_path_style {
            builder = builder.force_path_style(force_path_style);
        }
        if let Some(credentials) = &self.client_config.credentials {
            builder =
                builder.credentials_provider(SharedCredentialsProvider::new(Credentials::new(
                    credentials.access_key_id.clone(),
                    credentials.secret_access_key.clone(),
                    None,
                    None,
                    "checkpoint-syncer",
                )));
        }
        if protect_endpoint {
            let mut connector =
                hyper::client::HttpConnector::new_with_resolver(PublicDnsResolver::default());
            connector.enforce_http(false);
            let connector = HttpsConnectorBuilder::new()
                .with_native_roots()
                .https_or_http()
                .enable_http1()
                .enable_http2()
                .wrap_connector(connector);
            builder = builder.http_client(HyperClientBuilder::new().build(connector));
        }
        Client::from_conf(builder.build())
    }

    fn resolved_endpoint(&self) -> Option<String> {
        Self::resolve_endpoint(
            self.client_config.endpoint.clone(),
            env::var(AWS_ENDPOINT_URL_S3).ok(),
        )
    }

    fn resolve_endpoint(
        explicit_endpoint: Option<String>,
        environment_endpoint: Option<String>,
    ) -> Option<String> {
        explicit_endpoint.or_else(|| environment_endpoint.filter(|endpoint| !endpoint.is_empty()))
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
            .read_from_bucket(S3Storage::latest_index_key())
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
        self.read_from_bucket(S3Storage::checkpoint_key(index))
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
        let scheme = if self.resolved_endpoint().is_some()
            || self.client_config.force_path_style.is_some()
        {
            "s3+custom"
        } else {
            "s3"
        };
        let encoded_folder = self.folder.as_deref().map(|folder| {
            url::form_urlencoded::byte_serialize(folder.as_bytes()).collect::<String>()
        });
        let folder = if scheme == "s3+custom" {
            encoded_folder.as_deref()
        } else {
            self.folder.as_deref()
        };
        let location = match folder {
            None | Some("") => format!("{scheme}://{}/{}", self.bucket, self.region),
            Some(folder_str) => {
                format!("{scheme}://{}/{}/{}", self.bucket, self.region, folder_str)
            }
        };
        let endpoint = self.resolved_endpoint();
        if endpoint.is_none() && self.client_config.force_path_style.is_none() {
            return location;
        }

        let mut query = url::form_urlencoded::Serializer::new(String::new());
        if let Some(endpoint) = endpoint {
            query.append_pair("endpoint", &endpoint);
        }
        if let Some(force_path_style) = self.client_config.force_path_style {
            query.append_pair("forcePathStyle", &force_path_style.to_string());
        }
        format!("{location}?{}", query.finish())
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
        let file = self.read_from_bucket(S3Storage::reorg_flag_key()).await?;

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

    #[derive(Clone)]
    struct FixedResolver(SocketAddr);

    impl Service<Name> for FixedResolver {
        type Response = std::iter::Once<SocketAddr>;
        type Error = std::io::Error;
        type Future = std::future::Ready<Result<Self::Response, Self::Error>>;

        fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn call(&mut self, _name: Name) -> Self::Future {
            std::future::ready(Ok(std::iter::once(self.0)))
        }
    }

    #[tokio::test]
    async fn test_announcement_location() {
        // Test with a folder
        let s3_storage = S3Storage::new(
            "test-bucket".to_string(),
            Some("test-folder".to_string()),
            Region::new("us-east-1"),
            S3ClientConfig::default(),
            None,
        );
        let location = s3_storage.announcement_location();
        assert_eq!(location, "s3://test-bucket/us-east-1/test-folder");

        // Test without a folder
        let s3_storage = S3Storage::new(
            "test-bucket".to_string(),
            None,
            Region::new("us-east-1"),
            S3ClientConfig::default(),
            None,
        );
        let location = s3_storage.announcement_location();
        assert_eq!(location, "s3://test-bucket/us-east-1");

        let custom_storage = S3Storage::new(
            "test-bucket".to_string(),
            Some("test-folder".to_string()),
            Region::new("nyc3"),
            S3ClientConfig {
                endpoint: Some("https://nyc3.digitaloceanspaces.com".to_string()),
                force_path_style: Some(true),
                ..Default::default()
            },
            None,
        );
        assert_eq!(
            custom_storage.announcement_location(),
            "s3+custom://test-bucket/nyc3/test-folder?endpoint=https%3A%2F%2Fnyc3.digitaloceanspaces.com&forcePathStyle=true"
        );
    }

    #[test]
    fn explicit_endpoint_precedes_environment_fallback() {
        assert_eq!(
            S3Storage::resolve_endpoint(
                Some("https://explicit.example.com".to_string()),
                Some("https://environment.example.com".to_string()),
            )
            .as_deref(),
            Some("https://explicit.example.com")
        );
        assert_eq!(
            S3Storage::resolve_endpoint(None, Some("https://environment.example.com".to_string()),)
                .as_deref(),
            Some("https://environment.example.com")
        );
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

    /// Builds a plain HTTP-only S3 client pointed at a local mock server. Building an explicit
    /// connector avoids the SDK's default TLS-capable connector, which eagerly loads the OS
    /// certificate store even when it'll never be used for a plain-http request.
    fn test_client(addr: std::net::SocketAddr) -> Client {
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
        Client::from_conf(config)
    }

    /// Reads a mock HTTP server's request off `socket` up to the end of the headers. The
    /// connection stays open afterwards (the client is waiting on a response), so EOF never
    /// comes.
    async fn read_request_headers(socket: &mut tokio::net::TcpStream) -> Vec<u8> {
        use tokio::io::AsyncReadExt;

        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = socket
                .read(&mut chunk)
                .await
                .expect("reading the request must succeed");
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        buf
    }

    async fn discard_request_headers(socket: &mut tokio::net::TcpStream) {
        read_request_headers(socket).await;
    }

    #[tokio::test]
    async fn custom_endpoint_uses_path_style_and_scoped_credentials() {
        use aws_sdk_s3::config::{Credentials, SharedCredentialsProvider};
        use tokio::io::AsyncWriteExt;
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
            let request = read_request_headers(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .expect("writing the response must succeed");
            request
        });

        let shared_config = SdkConfig::builder()
            .behavior_version(BehaviorVersion::latest())
            .region(Region::new("us-east-1"))
            .credentials_provider(SharedCredentialsProvider::new(Credentials::for_tests()))
            .build();
        let storage = S3Storage::new(
            "test-bucket".to_string(),
            None,
            Region::new("us-east-1"),
            S3ClientConfig {
                endpoint: Some(format!("http://{addr}")),
                force_path_style: Some(true),
                credentials: Some(S3Credentials {
                    access_key_id: "custom-access-key".to_string(),
                    secret_access_key: "custom-secret-key".to_string(),
                }),
                endpoint_is_announced: false,
            },
            None,
        );

        storage
            .client_from_sdk_config(
                &shared_config,
                storage.client_config.endpoint.as_deref(),
                false,
            )
            .put_object()
            .bucket("test-bucket")
            .key("metadata_latest.json")
            .body(Vec::new().into())
            .send()
            .await
            .expect("the request must use the configured endpoint");

        let request = server.await.expect("the mock server task must not panic");
        let request = String::from_utf8(request).expect("request headers must be UTF-8");
        assert!(
            request
                .starts_with("PUT /test-bucket/metadata_latest.json?x-id=PutObject HTTP/1.1\r\n"),
            "unexpected request target: {request}"
        );
        assert!(
            request.contains("Credential=custom-access-key/"),
            "request did not use scoped credentials: {request}"
        );
    }

    #[tokio::test]
    async fn credentialed_reads_use_per_instance_clients() {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("binding a loopback listener must succeed");
        let addr = listener
            .local_addr()
            .expect("a bound listener must have a local address");

        let server = tokio::spawn(async move {
            let mut requests = Vec::new();
            for _ in 0..2 {
                let (mut socket, _) = listener
                    .accept()
                    .await
                    .expect("each test client must connect");
                requests.push(read_request_headers(&mut socket).await);
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    )
                    .await
                    .expect("writing the response must succeed");
            }
            requests
        });

        let storage = |access_key_id: &str| {
            S3Storage::new(
                "test-bucket".to_string(),
                None,
                Region::new("us-east-1"),
                S3ClientConfig {
                    endpoint: Some(format!("http://{addr}")),
                    force_path_style: Some(true),
                    credentials: Some(S3Credentials {
                        access_key_id: access_key_id.to_string(),
                        secret_access_key: "custom-secret-key".to_string(),
                    }),
                    endpoint_is_announced: false,
                },
                None,
            )
        };
        let first = storage("first-access-key");
        let second = storage("second-access-key");

        first
            .read_from_bucket("metadata_latest.json".to_string())
            .await
            .expect("the first credentialed read must succeed");
        second
            .read_from_bucket("metadata_latest.json".to_string())
            .await
            .expect("the second credentialed read must succeed");

        let requests = server.await.expect("the mock server task must not panic");
        let requests: Vec<_> = requests
            .into_iter()
            .map(|request| String::from_utf8(request).expect("request headers must be UTF-8"))
            .collect();
        assert!(
            requests[0].contains("Credential=first-access-key/"),
            "first read used the wrong credentials: {}",
            requests[0]
        );
        assert!(
            requests[1].contains("Credential=second-access-key/"),
            "second read used the wrong credentials: {}",
            requests[1]
        );
    }

    #[test]
    fn custom_announcement_round_trip_marks_endpoint_untrusted() {
        use std::str::FromStr;

        use crate::settings::CheckpointSyncerConf;

        let configured_storage = S3Storage::new(
            "test-bucket".to_string(),
            Some("releases?candidate".to_string()),
            Region::new("nyc3"),
            S3ClientConfig {
                endpoint: Some("https://nyc3.digitaloceanspaces.com".to_string()),
                force_path_style: Some(true),
                ..Default::default()
            },
            None,
        );
        let announcement = configured_storage.announcement_location();
        let parsed = CheckpointSyncerConf::from_str(&announcement)
            .expect("the custom announcement must parse");
        let CheckpointSyncerConf::S3 {
            folder,
            endpoint,
            force_path_style,
            credentials,
            endpoint_is_announced,
            ..
        } = parsed
        else {
            panic!("expected an S3 checkpoint syncer");
        };

        assert_eq!(folder.as_deref(), Some("releases?candidate"));
        assert_eq!(
            endpoint.as_deref(),
            Some("https://nyc3.digitaloceanspaces.com")
        );
        assert_eq!(force_path_style, Some(true));
        assert!(credentials.is_none());
        assert!(endpoint_is_announced);
    }

    #[tokio::test]
    async fn announced_endpoint_resolver_rejects_private_address() {
        use std::str::FromStr;

        let private_address = SocketAddr::from(([127, 0, 0, 1], 9000));
        let mut resolver = PublicDnsResolver {
            inner: FixedResolver(private_address),
        };
        let err = resolver
            .call(Name::from_str("s3.example.com").unwrap())
            .await
            .expect_err("private DNS answers must be rejected");

        assert!(err.to_string().contains("non-public address 127.0.0.1"));
    }

    /// Proves the abort happens mid-transfer, not just on the buffered result: a local server
    /// declares a 1GiB body and streams for as long as the client keeps reading.
    ///
    /// The assertion is on wall-clock time, not bytes written: how many bytes the server
    /// manages to hand to the kernel before `write_all` starts failing depends on OS-specific
    /// socket buffer sizes on both ends of the loopback connection (send buffer here, receive
    /// buffer on the client side, which this test doesn't control) - on a previous version of
    /// this test that asserted a fixed byte ceiling, a CI runner with larger default buffers
    /// buffered ~3.9MiB before failing, well past the ceiling, even though the connection was
    /// in fact torn down promptly. Once the client drops the `ByteStream` (immediately after
    /// `read_capped` bails), the underlying connection closes and the server's blocking writes
    /// start erroring within a bounded, short time - regardless of how many bytes it managed to
    /// buffer first. If the download weren't actually being aborted, the server would keep
    /// streaming (and this future would keep awaiting) for as long as it takes to send 1GiB.
    #[tokio::test]
    async fn read_from_bucket_aborts_download_of_oversized_object() {
        use tokio::io::AsyncWriteExt;
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

            discard_request_headers(&mut socket).await;

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

        let res = test_client(addr)
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

        let total_written = tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .expect(
                "the mock server never observed the disconnect - the download is not actually \
                 being aborted mid-transfer, it's still streaming toward the declared 1GiB",
            )
            .expect("the mock server task must not panic");
        // A generous sanity ceiling, not the primary assertion above: proves we're nowhere near
        // having streamed the full declared size, without depending on an exact OS buffer size.
        assert!(
            total_written < 64 * 1024 * 1024,
            "server streamed {total_written} bytes, unexpectedly close to the declared 1GiB"
        );
    }

    /// Proves that a connection which stalls after headers - never sending any body, and never
    /// closing - is bounded by `read_capped`'s own timeout rather than hanging forever. Without
    /// wrapping the body read in a timeout, this future would never resolve, since the SDK's
    /// operation timeout only covers request transmission and response headers.
    #[tokio::test]
    async fn read_capped_times_out_on_stalled_body() {
        use tokio::io::AsyncWriteExt;
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

            discard_request_headers(&mut socket).await;

            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n")
                .await
                .expect("writing response headers must succeed");

            // Never send any body, and hold the connection open indefinitely.
            tokio::time::sleep(Duration::from_secs(60)).await;
        });

        let res = test_client(addr)
            .get_object()
            .bucket("test-bucket")
            .key("stalled-object")
            .send()
            .await
            .expect("fake server always returns 200");

        let start = tokio::time::Instant::now();
        let err = read_capped_with_timeout(res.body, "stalled-object", Duration::from_millis(200))
            .await
            .expect_err("a stalled body must eventually time out, not hang forever");
        assert!(err.to_string().contains("Timed out"));
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "read_capped_with_timeout took {:?} to time out - the bound isn't being enforced",
            start.elapsed()
        );

        server.abort();
    }
}
