#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    error::Error,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, OnceLock},
    time::Duration,
};

use async_trait::async_trait;
use cache_types::SerializedOffchainLookup;
use derive_more::Deref;
use derive_new::new;
use ethers::{abi::AbiDecode, core::utils::hex::decode as hex_decode};
// reqwest 0.11's `dns::Resolve` trait uses hyper 0.14's `Name` directly (no
// wrapper). If reqwest is bumped to 0.12+, this must switch to
// `reqwest::dns::Name` — the 0.12 trait wraps `Name` in a private-field struct.
use hyper::client::connect::dns::Name;
use hyperlane_base::cache::FunctionCallCache;
use moka::future::Cache;
use regex::Regex;
use reqwest::{
    dns::{Addrs, Resolve, Resolving},
    header::CONTENT_TYPE,
    redirect::Policy,
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use tracing::{info, instrument, warn};

use hyperlane_core::{
    h512_to_bytes, utils::bytes_to_hex, CcipReadIsm, HyperlaneMessage, HyperlaneSigner,
    HyperlaneSignerExt, Metadata, ModuleType, RawHyperlaneMessage, Signable, H160, H256,
};
use hyperlane_ethereum::OffchainLookup;

use crate::msg::metadata::base_builder::IsmBuildMetricsParams;

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    message_builder::MessageMetadataBuilder,
    MetadataBuilder,
};

mod cache_types;

pub const DEFAULT_TIMEOUT: u64 = 30;

/// Authentication signatures are timeless and fully determined by the signer and signing hash.
/// Keep a bounded process-local cache so CCIP pending retries and concurrent messages do not send
/// the same digest to KMS repeatedly.
type CcipSignatureCache = Cache<(H160, H256), String>;

static CCIP_SIGNATURE_CACHE: OnceLock<CcipSignatureCache> = OnceLock::new();

fn ccip_signature_cache() -> &'static CcipSignatureCache {
    CCIP_SIGNATURE_CACHE.get_or_init(|| Cache::builder().max_capacity(10_000).build())
}

/// Process-wide client so requests to CCIP-read servers can reuse pooled connections.
static CCIP_HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

fn ccip_http_client() -> Result<&'static Client, Box<MetadataBuildError>> {
    match CCIP_HTTP_CLIENT
        .get_or_init(|| build_ccip_http_client(PublicDnsResolver).map_err(|err| err.to_string()))
    {
        Ok(client) => Ok(client),
        Err(err) => Err(Box::new(MetadataBuildError::FailedToBuild(format!(
            "Failed to build CCIP-read HTTP client: {err}"
        )))),
    }
}

fn build_ccip_http_client<R>(resolver: R) -> Result<Client, reqwest::Error>
where
    R: Resolve + 'static,
{
    Client::builder()
        .dns_resolver(Arc::new(resolver))
        .redirect(Policy::none())
        .no_proxy()
        .build()
}

#[derive(Debug)]
struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(resolve_public_host(name.as_str().to_owned()))
    }
}

type ResolverError = Box<dyn Error + Send + Sync>;

async fn resolve_public_host(host: String) -> Result<Addrs, ResolverError> {
    let addrs = tokio::net::lookup_host((host.as_str(), 0)).await?;
    let addrs = validate_resolved_addrs(&host, addrs)?;
    Ok(Box::new(addrs.into_iter()))
}

fn validate_resolved_addrs(
    host: &str,
    addrs: impl IntoIterator<Item = SocketAddr>,
) -> Result<Vec<SocketAddr>, ResolverError> {
    let addrs: Vec<_> = addrs.into_iter().collect();
    if addrs.is_empty() {
        return Err(format!("CCIP-read host {host} resolved to no addresses").into());
    }

    if let Some(address) = addrs.iter().find(|addr| !is_public_ip(addr.ip())) {
        return Err(format!(
            "CCIP-read host {host} resolved to non-public address {}",
            address.ip()
        )
        .into());
    }

    Ok(addrs)
}

fn validate_ccip_url(url: &str) -> Result<Url, Box<MetadataBuildError>> {
    let url = Url::parse(url).map_err(|err| {
        Box::new(MetadataBuildError::FailedToBuild(format!(
            "Invalid CCIP-read URL: {err}"
        )))
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Box::new(MetadataBuildError::FailedToBuild(format!(
            "Unsupported CCIP-read URL scheme: {}",
            url.scheme()
        ))));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(Box::new(MetadataBuildError::FailedToBuild(
            "CCIP-read URLs must not contain credentials".to_owned(),
        )));
    }

    let host = url.host_str().ok_or_else(|| {
        Box::new(MetadataBuildError::FailedToBuild(
            "CCIP-read URL has no host".to_owned(),
        ))
    })?;
    let host = host
        .strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err(Box::new(MetadataBuildError::FailedToBuild(format!(
                "CCIP-read URL contains non-public address {ip}"
            ))));
        }
    }

    Ok(url)
}

fn is_public_ip(ip: IpAddr) -> bool {
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

    // Public IPv6 unicast currently lives in 2000::/3. Exclude special-purpose
    // subranges and transition mechanisms that can embed IPv4 destinations.
    octets[0] & 0xe0 == 0x20
        // 2001:0000::/32 (Teredo) and 2001:0002::/48 (benchmarking)
        && !((octets[0] == 0x20 && octets[1] == 0x01 && matches!(octets[2], 0x00 | 0x02))
            // 2001:db8::/32 (documentation)
            || (octets[0] == 0x20 && octets[1] == 0x01 && octets[2] == 0x0d && octets[3] == 0xb8)
            // 2002::/16 (6to4)
            || (octets[0] == 0x20 && octets[1] == 0x02)
            // 3fff::/20 (documentation)
            || (octets[0] == 0x3f && octets[1] == 0xff && octets[2] & 0xf0 == 0))
}

/// Maximum JSON response size accepted from a CCIP-read server.
///
/// CCIP-read metadata has no protocol-level size limit. One MiB still permits roughly 500 KiB
/// of binary metadata after JSON and hex encoding, while bounding memory consumed by an
/// untrusted server response.
const MAX_CCIP_RESPONSE_SIZE: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
struct OffchainLookupRequestBody {
    pub data: String,
    pub sender: String,
    pub signature: Option<String>,
    pub origin_tx_hash: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct OffchainResponse {
    data: String,
}

#[derive(Clone, Debug, new, Deref)]
pub struct CcipReadIsmMetadataBuilder {
    base: MessageMetadataBuilder,
}

/// An authenticated offchain lookup payload
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize, Debug)]
pub struct HyperlaneAuthenticatedOffchainLookup {
    url_template: Vec<u8>,
    sender: H160,
    call_data: Vec<u8>,
}

impl Signable for HyperlaneAuthenticatedOffchainLookup {
    fn signing_hash(&self) -> H256 {
        H256::from_slice(
            Keccak256::new()
                .chain(b"HYPERLANE_OFFCHAINLOOKUP")
                .chain(self.sender)
                .chain(self.call_data.as_slice())
                .chain(self.url_template.as_slice())
                .finalize()
                .as_slice(),
        )
    }
}

impl CcipReadIsmMetadataBuilder {
    /// Generate a relayer authentication signature (EIP-191) over call_data and sender and the url template
    async fn generate_signature_hex<S: HyperlaneSigner>(
        signer: &S,
        info: &OffchainLookup,
        url: &str,
    ) -> Result<String, MetadataBuildError> {
        // Derive the hash over call_data and sender
        let signable = HyperlaneAuthenticatedOffchainLookup {
            url_template: url.to_owned().into(),
            call_data: info.call_data.clone().to_vec(),
            sender: info.sender.into(),
        };
        let cache_key = (signer.eth_address(), signable.signing_hash());

        ccip_signature_cache()
            .try_get_with(cache_key, async {
                // EIP-191 compliant signature over the signing hash of the
                // HyperlaneOffchainLookupAttestation.
                let signed = signer.sign(signable).await.map_err(|e| e.to_string())?;
                let sig_bytes: [u8; 65] = signed.signature.into();
                Ok::<_, String>(bytes_to_hex(&sig_bytes))
            })
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))
    }

    /// GET-style CCIP requests have no request body, so there is nowhere to
    /// send the relayer authentication signature.
    async fn generate_signature_for_post_request<S: HyperlaneSigner>(
        signer: Option<&S>,
        info: &OffchainLookup,
        url: &str,
    ) -> Result<Option<String>, MetadataBuildError> {
        if url.contains("{data}") {
            return Ok(None);
        }

        match signer {
            Some(signer) => Self::generate_signature_hex(signer, info, url)
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    /// Returns info on how to query for offchain information
    /// This method will attempt to get the value from cache first. If it is a cache miss,
    /// it will request it from the ISM contract. The result will be cached for future use.
    ///
    /// Implicit contract in this method: function name `get_offchain_verify_info` matches
    /// the name of the method `get_offchain_verify_info`.
    async fn call_get_offchain_verify_info(
        &self,
        ism: Box<dyn CcipReadIsm>,
        message: &HyperlaneMessage,
    ) -> Result<OffchainLookup, MetadataBuildError> {
        let ism_domain = ism.domain().name();
        let fn_key = "get_offchain_verify_info";
        // To have the cache key be more succinct, we use the message id
        let call_params = (ism.address(), message.id());

        let info_from_cache = self
            .base
            .base_builder()
            .cache()
            .get_cached_call_result::<SerializedOffchainLookup>(ism_domain, fn_key, &call_params)
            .await
            .map_err(|err| {
                warn!(error = %err, message_id = ?message.id(), "Error when caching call result for {:?}", fn_key);
            })
            .ok()
            .flatten();

        let info: OffchainLookup = match info_from_cache {
            Some(info) => info.into(),
            None => {
                let response = ism
                    .get_offchain_verify_info(RawHyperlaneMessage::from(message).to_vec())
                    .await;

                match response {
                    Ok(_) => {
                        info!(message_id = ?message.id(), "incorrectly configured getOffchainVerifyInfo, expected revert");
                        return Err(MetadataBuildError::CouldNotFetch);
                    }
                    Err(raw_error) => {
                        let matching_regex = Regex::new(r"0x[[:xdigit:]]+").map_err(|err| {
                            let msg = format!("Failed to parse regex: {err}");
                            MetadataBuildError::FailedToBuild(msg)
                        })?;
                        if let Some(matching) = &matching_regex.captures(&raw_error.to_string()) {
                            let hex_val = hex_decode(&matching[0][2..]).map_err(|err| {
                                let msg = format!("Failed to decode hex from ISM response: {err}");
                                MetadataBuildError::FailedToBuild(msg)
                            })?;
                            OffchainLookup::decode(hex_val).map_err(|err| {
                                let msg = format!("Failed to decode offchain lookup struct: {err}");
                                MetadataBuildError::FailedToBuild(msg)
                            })?
                        } else {
                            info!(?raw_error, message_id = ?message.id(), "unable to parse custom error out of revert");
                            return Err(MetadataBuildError::CouldNotFetch);
                        }
                    }
                }
            }
        };

        self.base
            .base_builder()
            .cache()
            .cache_call_result(
                ism_domain,
                fn_key,
                &call_params,
                &SerializedOffchainLookup::from(info.clone()),
            )
            .await
            .map_err(|err| {
                warn!(error = %err, message_id = ?message.id(), "Error when caching call result for {:?}", fn_key);
            })
            .ok();

        Ok(info)
    }
}

#[async_trait]
impl MetadataBuilder for CcipReadIsmMetadataBuilder {
    #[instrument(err, skip(self, message, params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let res = metadata_build(self, ism_address, message, params).await;

        // update metrics
        let ism_build_metrics_params = IsmBuildMetricsParams {
            app_context: self.base.app_context.clone(),
            success: res.is_ok(),
            origin: self.base_builder().origin_domain().clone(),
            destination: self.base_builder().destination_domain().clone(),
            ism_type: ModuleType::CcipRead,
        };
        self.base_builder()
            .update_ism_metric(ism_build_metrics_params);
        res
    }
}

async fn metadata_build(
    ism_builder: &CcipReadIsmMetadataBuilder,
    ism_address: H256,
    message: &HyperlaneMessage,
    _params: MessageMetadataBuildParams,
) -> Result<Metadata, MetadataBuildError> {
    let ism = ism_builder
        .base
        .base_builder()
        .build_ccip_read_ism(ism_address)
        .await
        .map_err(|err| {
            let msg = format!("Failed to build CCIP read ISM: {err}");
            MetadataBuildError::FailedToBuild(msg)
        })?;

    let info = ism_builder
        .call_get_offchain_verify_info(ism, message)
        .await?;

    let origin_tx_hash = ism_builder
        .base
        .base_builder()
        .retrieve_origin_tx_hash_by_message_id(message.id())
        .await
        .map_err(|err| {
            warn!(error = %err, "Error retrieving origin tx hash for message {:?}", message.id());
        })
        .ok()
        .flatten()
        .map(|h| bytes_to_hex(&h512_to_bytes(&h)));
    tracing::debug!(
        message_id = ?message.id(),
        origin_tx_hash = ?origin_tx_hash,
        found_in_db = origin_tx_hash.is_some(),
        "Origin tx hash lookup result",
    );

    for url in info.urls.iter() {
        // Retry this URL while attestation is pending (transient), up to 10 attempts at 1s intervals.
        // Move to the next URL only on hard failures.
        const MAX_PENDING_RETRIES: u32 = 10;
        let mut pending_attempts = 0u32;
        tracing::info!(?ism_address, url, message_id = ?message.id(), "Fetching CCIP read offchain data");
        loop {
            match fetch_offchain_data(
                ism_builder,
                &info,
                url,
                origin_tx_hash.clone(),
                message.id(),
            )
            .await
            {
                Ok(data) => {
                    tracing::info!(
                        ?ism_address,
                        url,
                        message_id = ?message.id(),
                        origin_tx_hash = ?origin_tx_hash,
                        attempts = pending_attempts,
                        "Successfully fetched offchain lookup data"
                    );
                    return Ok(data);
                }
                Err(FetchOutcome::Pending) if pending_attempts < MAX_PENDING_RETRIES => {
                    pending_attempts = pending_attempts.saturating_add(1);
                    tracing::debug!(
                        ?ism_address,
                        url,
                        message_id = ?message.id(),
                        origin_tx_hash = ?origin_tx_hash,
                        attempt = pending_attempts,
                        max = MAX_PENDING_RETRIES,
                        "Attestation pending, retrying in 1s"
                    );
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(FetchOutcome::Pending) => {
                    tracing::warn!(
                        ?ism_address,
                        url,
                        message_id = ?message.id(),
                        origin_tx_hash = ?origin_tx_hash,
                        max = MAX_PENDING_RETRIES,
                        "Attestation still pending after max retries"
                    );
                    break;
                }
                Err(FetchOutcome::Failed(err)) => {
                    tracing::warn!(?ism_address, url, message_id = ?message.id(), origin_tx_hash = ?origin_tx_hash, error = ?err, "Failed to fetch offchain data");
                    break;
                }
            }
        }
    }

    // No metadata endpoints or endpoints down
    Err(MetadataBuildError::CouldNotFetch)
}

/// Private result type for [`fetch_offchain_data`].
/// `Pending` signals a transient "not yet available" from the offchain server and
/// is only ever produced and consumed inside this module — it never escapes to
/// [`MetadataBuildError`].
enum FetchOutcome {
    Pending,
    Failed(MetadataBuildError),
}

impl From<MetadataBuildError> for FetchOutcome {
    fn from(e: MetadataBuildError) -> Self {
        FetchOutcome::Failed(e)
    }
}

/// Returns true when an offchain-lookup response body explicitly signals that
/// an attestation is not yet available.
///
/// Checks two shapes:
/// - Circle's attestation API: `{"status": "pending", ...}`
/// - Generic CCIP-read servers: `{"error": "... pending ..."}`
/// - ccip-server wrapping Circle 404: `{"error": "CCTP attestation not found"}`
///   (Circle 404 = attestation not yet processed; treated as pending)
fn body_signals_pending(body: &str) -> bool {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    let status_pending = val
        .get("status")
        .and_then(|s| s.as_str())
        .is_some_and(|s| s.eq_ignore_ascii_case("pending"));
    let error_pending = val.get("error").and_then(|s| s.as_str()).is_some_and(|s| {
        let l = s.to_lowercase();
        l.contains("pending") || l == "cctp attestation not found"
    });
    status_pending || error_pending
}

/// Reads an untrusted CCIP response incrementally, enforcing the limit against bytes received.
/// `Content-Length` is only an early-rejection optimization because a server can omit or falsify
/// it, and decompression can change the actual body size.
async fn read_response_body(mut res: reqwest::Response) -> Result<String, MetadataBuildError> {
    if res
        .content_length()
        .is_some_and(|length| length > MAX_CCIP_RESPONSE_SIZE as u64)
    {
        return Err(MetadataBuildError::FailedToBuild(format!(
            "Offchain lookup server response exceeds the {MAX_CCIP_RESPONSE_SIZE} byte limit"
        )));
    }

    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|err| {
        MetadataBuildError::FailedToBuild(format!(
            "Failed to read offchain lookup server response: ({err})"
        ))
    })? {
        if chunk.len() > MAX_CCIP_RESPONSE_SIZE.saturating_sub(body.len()) {
            return Err(MetadataBuildError::FailedToBuild(format!(
                "Offchain lookup server response exceeds the {MAX_CCIP_RESPONSE_SIZE} byte limit"
            )));
        }
        body.extend_from_slice(&chunk);
    }

    String::from_utf8(body).map_err(|err| {
        MetadataBuildError::FailedToBuild(format!(
            "Offchain lookup server response is not valid UTF-8: ({err})"
        ))
    })
}

// Boxed error: `MetadataBuildError`'s largest variant is >100 bytes, which trips
// `clippy::result_large_err` for sync fns (async fns like `read_response_body`
// return a future and are exempt).
fn decode_response_data(data: &str) -> Result<Metadata, Box<MetadataBuildError>> {
    let hex_data = data.strip_prefix("0x").ok_or_else(|| {
        Box::new(MetadataBuildError::FailedToBuild(format!(
            "Offchain lookup server response data is missing the 0x prefix: ({data})"
        )))
    })?;

    let metadata = hex_decode(hex_data).map_err(|err| {
        Box::new(MetadataBuildError::FailedToBuild(format!(
            "Failed to decode hex from offchain lookup server response: err: ({err}), data: ({data})"
        )))
    })?;
    Ok(Metadata::new(metadata))
}

/// Fetch data from offchain lookup server
async fn fetch_offchain_data(
    ism_builder: &CcipReadIsmMetadataBuilder,
    info: &OffchainLookup,
    url: &str,
    origin_tx_hash: Option<String>,
    message_id: H256,
) -> Result<Metadata, FetchOutcome> {
    // Need to explicitly convert the sender H160 the hex because the `ToString` implementation
    // for `H160` truncates the output. (e.g. `0xc66a…7b6f` instead of returning
    // the full address)
    let sender_as_bytes = bytes_to_hex(info.sender.as_bytes());
    let data_as_bytes = info.call_data.to_string();
    let interpolated_url = url
        .replace("{sender}", &sender_as_bytes)
        .replace("{data}", &data_as_bytes);
    let interpolated_url =
        validate_ccip_url(&interpolated_url).map_err(|e| FetchOutcome::from(*e))?;
    let client = ccip_http_client().map_err(|e| FetchOutcome::from(*e))?;

    // Validate the destination before invoking a remote signer.
    let maybe_signature_hex = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
        ism_builder.base.base_builder().get_signer(),
        info,
        url,
    )
    .await?;

    let res = if !url.contains("{data}") {
        let body = OffchainLookupRequestBody {
            sender: sender_as_bytes,
            data: data_as_bytes,
            signature: maybe_signature_hex,
            origin_tx_hash,
        };
        tracing::debug!(
            url = %interpolated_url,
            ?body,
            ?message_id,
            "Sending POST request to offchain lookup server"
        );
        client
            .request(Method::POST, interpolated_url)
            .header(CONTENT_TYPE, "application/json")
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT))
            .json(&body)
            .send()
            .await
            .map_err(|err| {
                let msg =
                    format!("Failed to request offchain lookup server with post method: {err}");
                MetadataBuildError::FailedToBuild(msg)
            })?
    } else {
        client
            .request(Method::GET, interpolated_url)
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT))
            .send()
            .await
            .map_err(|err| {
                let msg =
                    format!("Failed to request offchain lookup server with get method: {err}");
                MetadataBuildError::FailedToBuild(msg)
            })?
    };

    let status = res.status();

    let response_body = read_response_body(res).await?;
    tracing::debug!(
        response = response_body,
        status = status.as_u16(),
        ?message_id,
        "Received response from offchain lookup server"
    );

    if status == reqwest::StatusCode::NOT_FOUND {
        // A bare 404 without a pending body is an infrastructure error (misconfigured
        // route, wrong URL) — don't burn 30s of retries on it.
        return if body_signals_pending(&response_body) {
            Err(FetchOutcome::Pending)
        } else {
            Err(FetchOutcome::Failed(MetadataBuildError::FailedToBuild(
                format!("Offchain lookup server returned 404: {response_body}"),
            )))
        };
    }

    // For non-404 responses, check the body for an explicit "pending" signal.
    if body_signals_pending(&response_body) {
        return Err(FetchOutcome::Pending);
    }

    let json: OffchainResponse = serde_json::from_str(&response_body).map_err(|err| {
        let error_msg = format!(
            "Failed to parse offchain lookup server json response: ({err}) ({response_body})"
        );
        MetadataBuildError::FailedToBuild(error_msg)
    })?;

    decode_response_data(&json.data).map_err(|e| FetchOutcome::from(*e))
}

#[cfg(test)]
mod test {
    use std::{
        net::SocketAddr,
        str::FromStr,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
        vec,
    };

    use axum::{extract::ConnectInfo, http::StatusCode, response::Redirect, routing::get, Router};
    use ethers::types::H160 as EthersH160;
    use futures::future::join_all;
    use hyperlane_core::{HyperlaneSignerError, Signature as HyperlaneSignature, SignedType, U256};
    use hyperlane_ethereum::Signers;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    use super::*;

    #[derive(Debug)]
    struct CountingSigner {
        address: H160,
        calls: AtomicUsize,
        failures_remaining: AtomicUsize,
        delay: Duration,
    }

    impl CountingSigner {
        fn new(address_byte: u8) -> Self {
            Self {
                address: H160::repeat_byte(address_byte),
                calls: AtomicUsize::new(0),
                failures_remaining: AtomicUsize::new(0),
                delay: Duration::ZERO,
            }
        }

        fn failing_once(address_byte: u8) -> Self {
            Self {
                failures_remaining: AtomicUsize::new(1),
                ..Self::new(address_byte)
            }
        }

        fn delayed(address_byte: u8) -> Self {
            Self {
                delay: Duration::from_millis(50),
                ..Self::new(address_byte)
            }
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl HyperlaneSigner for CountingSigner {
        fn eth_address(&self) -> H160 {
            self.address
        }

        async fn sign_hash(
            &self,
            _hash: &H256,
        ) -> Result<HyperlaneSignature, HyperlaneSignerError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            if self
                .failures_remaining
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                let err: Box<dyn std::error::Error + Send + Sync> =
                    Box::new(std::io::Error::other("simulated signer failure"));
                return Err(err.into());
            }

            Ok(HyperlaneSignature {
                r: U256::from(1),
                s: U256::from(2),
                v: 27,
            })
        }
    }

    fn test_offchain_lookup(call_data: &[u8], sender_byte: u8, url: &str) -> OffchainLookup {
        OffchainLookup {
            call_data: call_data.to_vec().into(),
            sender: EthersH160::repeat_byte(sender_byte),
            urls: vec![url.to_owned()],
            callback_function: [0, 0, 0, 0],
            extra_data: vec![].into(),
        }
    }

    #[derive(Debug)]
    struct FixedResolver(SocketAddr);

    impl Resolve for FixedResolver {
        fn resolve(&self, _name: Name) -> Resolving {
            let addrs: Addrs = Box::new(std::iter::once(self.0));
            Box::pin(async move { Ok(addrs) })
        }
    }

    #[tokio::test]
    async fn test_ccip_http_client_reuses_connections() -> eyre::Result<()> {
        async fn peer_port(ConnectInfo(address): ConnectInfo<SocketAddr>) -> String {
            address.port().to_string()
        }

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let router = Router::new().route("/", get(peer_port));
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
        });

        let client = build_ccip_http_client(FixedResolver(address))?;
        let url = format!("http://ccip-read.example:{}", address.port());
        let first_peer_port = client.get(&url).send().await?.text().await?;
        let second_peer_port = client.get(&url).send().await?.text().await?;

        server.abort();
        assert_eq!(first_peer_port, second_peer_port);
        Ok(())
    }

    #[tokio::test]
    async fn test_ccip_http_client_does_not_follow_redirects() {
        async fn redirect() -> Redirect {
            Redirect::temporary("/target")
        }

        let target_hits = Arc::new(AtomicUsize::new(0));
        let target_hits_for_route = target_hits.clone();
        let router = Router::new().route("/redirect", get(redirect)).route(
            "/target",
            get(move || {
                let target_hits = target_hits_for_route.clone();
                async move {
                    target_hits.fetch_add(1, Ordering::Relaxed);
                    StatusCode::OK
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let client = build_ccip_http_client(FixedResolver(address)).unwrap();
        let response = client
            .get(format!(
                "http://ccip-read.example:{}/redirect",
                address.port()
            ))
            .send()
            .await
            .unwrap();

        server.abort();
        assert_eq!(response.status().as_u16(), 307);
        assert_eq!(target_hits.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn test_generate_signature_hex() {
        // default hardhat key
        let signer = Signers::Local(
            ethers::signers::Wallet::from_str(
                "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            )
            .unwrap(),
        );
        let url = "http://example.com/namespace".to_string();
        let info = OffchainLookup {
            // from TestCcipReadIsm.sol
            call_data: "callDataToReturn".as_bytes().to_vec().into(),
            // from ccipread.hardhat-test.ts
            sender: EthersH160::from_str("4ee6ecad1c2dae9f525404de8555724e3c35d07b").unwrap(),
            urls: vec![url.clone()],
            callback_function: [0, 0, 0, 0],
            extra_data: vec![].into(),
        };

        let signature_hex =
            CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, &url)
                .await
                .unwrap();

        // 65 bytes = 130 hex chars + 2 for 0x
        assert_eq!(signature_hex.len(), 132);
        // Get the control from the hardhat test
        assert_eq!(
            signature_hex,
            "0x62e58f20c0b7ec4f071835eaf7aa2716707375740774188ecc60e7d91b565f7363deeba366b2609aee6b870ac6504a6cf482f00ecc0e9cbe34422bdcf88a4bd11b"
        );

        // Test the signature is valid
        let signable = HyperlaneAuthenticatedOffchainLookup {
            url_template: url.into(),
            sender: info.sender.into(),
            call_data: info.call_data.clone().to_vec(),
        };
        let signed = SignedType {
            value: signable,
            signature: ethers::types::Signature::from_str(&signature_hex)
                .unwrap()
                .into(),
        };
        assert!(signer.verify(&signed).is_ok());
    }

    #[tokio::test]
    async fn signature_cache_reuses_identical_signature() {
        let signer = CountingSigner::new(0x10);
        let url = "https://cache-reuse.example/lookup";
        let info = test_offchain_lookup(b"cache-reuse", 0x11, url);

        let first = CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)
            .await
            .unwrap();
        let second = CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)
            .await
            .unwrap();

        assert_eq!(first, second);
        assert_eq!(signer.calls(), 1);
    }

    #[tokio::test]
    async fn signature_cache_key_includes_signer_and_signing_hash() {
        let signer = CountingSigner::new(0x20);
        let other_signer = CountingSigner::new(0x21);
        let url = "https://cache-key.example/lookup";
        let info = test_offchain_lookup(b"cache-key", 0x22, url);
        let other_data = test_offchain_lookup(b"other-data", 0x22, url);
        let other_sender = test_offchain_lookup(b"cache-key", 0x23, url);

        CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)
            .await
            .unwrap();
        CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &other_data, url)
            .await
            .unwrap();
        CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &other_sender, url)
            .await
            .unwrap();
        CcipReadIsmMetadataBuilder::generate_signature_hex(
            &signer,
            &info,
            "https://other-url.example/lookup",
        )
        .await
        .unwrap();
        CcipReadIsmMetadataBuilder::generate_signature_hex(&other_signer, &info, url)
            .await
            .unwrap();

        assert_eq!(signer.calls(), 4);
        assert_eq!(other_signer.calls(), 1);
    }

    #[tokio::test]
    async fn signature_cache_coalesces_concurrent_requests() {
        let signer = CountingSigner::delayed(0x30);
        let url = "https://cache-concurrent.example/lookup";
        let info = test_offchain_lookup(b"cache-concurrent", 0x31, url);

        let results = join_all(
            (0..8).map(|_| CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)),
        )
        .await;

        assert!(results.iter().all(Result::is_ok));
        assert_eq!(signer.calls(), 1);
    }

    #[tokio::test]
    async fn signature_cache_does_not_cache_errors() {
        let signer = CountingSigner::failing_once(0x40);
        let url = "https://cache-error.example/lookup";
        let info = test_offchain_lookup(b"cache-error", 0x41, url);

        assert!(
            CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)
                .await
                .is_err()
        );
        assert!(
            CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)
                .await
                .is_ok()
        );
        assert!(
            CcipReadIsmMetadataBuilder::generate_signature_hex(&signer, &info, url)
                .await
                .is_ok()
        );

        assert_eq!(signer.calls(), 2);
    }

    #[tokio::test]
    async fn get_request_does_not_generate_signature() {
        let signer = CountingSigner::new(0x50);
        let url = "https://get.example/{data}";
        let info = test_offchain_lookup(b"get", 0x51, url);

        let signature = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
            Some(&signer),
            &info,
            url,
        )
        .await
        .unwrap();

        assert_eq!(signature, None);
        assert_eq!(signer.calls(), 0);
    }

    #[test]
    fn test_body_signals_pending() {
        // {"status": "pending"} -> pending
        assert!(body_signals_pending(r#"{"status":"pending"}"#));
        assert!(body_signals_pending(r#"{"status":"PENDING","foo":"bar"}"#));
        // {"error": "... pending ..."} -> pending
        assert!(body_signals_pending(
            r#"{"error":"CCTP attestation is pending"}"#
        ));
        // Circle 404 wrapped by ccip-server -> pending
        assert!(body_signals_pending(
            r#"{"error":"CCTP attestation not found"}"#
        ));
        // unrelated 404 error -> not pending
        assert!(!body_signals_pending(r#"{"error":"route not found"}"#));
        // empty / non-json -> not pending
        assert!(!body_signals_pending(""));
        assert!(!body_signals_pending("not json"));
        // success body -> not pending
        assert!(!body_signals_pending(r#"{"data":"0xdeadbeef"}"#));
    }

    #[tokio::test]
    async fn test_read_response_body_rejects_oversized_chunked_body() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test server must bind");
        let addr = listener
            .local_addr()
            .expect("listener must have an address");

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("client must connect");

            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let count = socket
                    .read(&mut buf)
                    .await
                    .expect("request must be readable");
                if count == 0 {
                    return;
                }
                request.extend_from_slice(&buf[..count]);
            }

            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
                )
                .await
                .expect("response headers must be writable");

            let chunk = vec![b'a'; 64 * 1024];
            let mut remaining = MAX_CCIP_RESPONSE_SIZE + 1;
            while remaining > 0 {
                let count = remaining.min(chunk.len());
                if socket
                    .write_all(format!("{count:X}\r\n").as_bytes())
                    .await
                    .is_err()
                    || socket.write_all(&chunk[..count]).await.is_err()
                    || socket.write_all(b"\r\n").await.is_err()
                {
                    return;
                }
                remaining -= count;
            }
            let _ = socket.write_all(b"0\r\n\r\n").await;
        });

        let response = Client::new()
            .get(format!("http://{addr}"))
            .send()
            .await
            .expect("test request must receive response headers");
        assert_eq!(response.content_length(), None);

        let err = read_response_body(response)
            .await
            .expect_err("an oversized chunked response must be rejected");
        assert!(err.to_string().contains("exceeds"));

        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("server must stop after the response is rejected")
            .expect("server task must not panic");
    }

    #[test]
    fn test_decode_response_data_validates_prefix_and_hex() {
        assert_eq!(
            decode_response_data("0xdeadBEEF")
                .expect("valid prefixed hex must decode")
                .as_ref(),
            [0xde, 0xad, 0xbe, 0xef]
        );
        assert!(decode_response_data("0x")
            .expect("empty bytes are valid metadata")
            .is_empty());

        for data in ["", "0", "deadbeef", "0Xdeadbeef", "🦀"] {
            let err = decode_response_data(data)
                .err()
                .expect("missing lowercase 0x prefix must be rejected without panicking");
            assert!(err.to_string().contains("missing the 0x prefix"));
        }

        for data in ["0x0", "0xzz"] {
            let err = decode_response_data(data)
                .err()
                .expect("invalid prefixed hex must be rejected without panicking");
            assert!(err.to_string().contains("Failed to decode hex"));
        }
    }

    #[test]
    fn test_ccip_url_rejects_non_http_schemes_and_credentials() {
        for url in [
            "ftp://example.com/data",
            "file:///etc/passwd",
            "data:text/plain,test",
            "https://user:password@example.com/data",
            "example.com/data",
        ] {
            assert!(validate_ccip_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_ccip_url("https://example.com/data").is_ok());
    }

    #[test]
    fn test_ccip_url_rejects_ipv4_literal_variants() {
        for url in [
            "http://127.0.0.1",
            "http://127.1",
            "http://2130706433",
            "http://0x7f000001",
            "http://0177.0.0.1",
            "http://0x7f.0.0.1",
            "http://10.0.0.1",
            "http://169.254.169.254/latest/meta-data",
            "http://192.168.1.1",
            "http://224.0.0.1",
        ] {
            assert!(validate_ccip_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_ccip_url("https://8.8.8.8/data").is_ok());
    }

    #[test]
    fn test_ccip_url_rejects_non_public_ipv6_literals() {
        for url in [
            "http://[::1]",
            "http://[::ffff:127.0.0.1]",
            "http://[::127.0.0.1]",
            "http://[fc00::1]",
            "http://[fe80::1]",
            "http://[2001:db8::1]",
            "http://[2002:7f00:1::]",
            "http://[3fff::1]",
        ] {
            assert!(validate_ccip_url(url).is_err(), "accepted {url}");
        }
        assert!(validate_ccip_url("https://[2606:4700:4700::1111]/data").is_ok());
    }

    #[test]
    fn test_dns_rejects_mixed_public_and_private_answers() {
        let answers = ["8.8.8.8:0".parse().unwrap(), "127.0.0.1:0".parse().unwrap()];
        assert!(validate_resolved_addrs("example.com", answers).is_err());
    }

    #[tokio::test]
    async fn test_public_dns_resolver_rejects_localhost() {
        assert!(resolve_public_host("localhost".to_owned()).await.is_err());
    }

    #[test]
    fn test_dns_accepts_only_public_answers() {
        let answers = [
            "8.8.8.8:0".parse().unwrap(),
            "[2606:4700:4700::1111]:0".parse().unwrap(),
        ];
        assert_eq!(
            validate_resolved_addrs("example.com", answers)
                .unwrap()
                .len(),
            2
        );
        assert!(validate_resolved_addrs("example.com", []).is_err());
    }
}
