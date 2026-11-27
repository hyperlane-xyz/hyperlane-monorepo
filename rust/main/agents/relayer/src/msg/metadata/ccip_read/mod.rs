#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue

use std::{
    error::Error,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, LazyLock, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
use moka::{future::Cache, Expiry};
use regex::Regex;
use reqwest::{
    dns::{Addrs, Resolve, Resolving},
    header::CONTENT_TYPE,
    redirect::Policy,
    Client, Method, Url,
};
use serde::{Deserialize, Serialize};
use tracing::{info, instrument, warn};

use hyperlane_core::{
    h512_to_bytes, offchain_lookup::OffchainLookupRequest, utils::bytes_to_hex, CcipReadIsm,
    HyperlaneMessage, HyperlaneSigner, Metadata, ModuleType, RawHyperlaneMessage, H160, H256,
};
use hyperlane_ethereum::OffchainLookup;

use crate::message_activity::{Activity, OffchainReadGateway, OffchainReadState};
use crate::msg::metadata::base_builder::IsmBuildMetricsParams;

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    message_builder::MessageMetadataBuilder,
    MetadataBuilder,
};

mod cache_types;

pub const DEFAULT_TIMEOUT: u64 = 30;

// Cache compilation without changing the metadata builder's error propagation.
static OFFCHAIN_LOOKUP_REGEX: LazyLock<Result<Regex, regex::Error>> =
    LazyLock::new(|| Regex::new(r"0x[[:xdigit:]]+"));

/// How long a signed request is reused, counted from when signing started.
/// Servers reject requests older than their own maximum age (30 s by default
/// on CCS); reuse stays well inside it.
const CCIP_SIGNATURE_REUSE: Duration = Duration::from_secs(5);

/// Selector of `CommitmentReadIsmService.getCallsFromRevealMessage(bytes)`,
/// the CCS reveal lookup and the only lookup the relayer signs.
const CCS_REVEAL_LOOKUP_SELECTOR: [u8; 4] = [0x2b, 0x4b, 0x00, 0xee];

const MISSING_REVEAL_ORIGIN_TX_HASH: &str =
    "CCS reveal lookup requires the origin transaction hash";

const REVEAL_NOT_FOR_MESSAGE: &str = "CCS reveal lookup does not carry the message being delivered";

fn is_ccs_reveal_lookup(info: &OffchainLookup) -> bool {
    info.call_data.starts_with(&CCS_REVEAL_LOOKUP_SELECTOR)
}

/// Whether the reveal lookup's call data is `getCallsFromRevealMessage(message)`
/// for the message being delivered, the only reveal CCS serves for it.
fn reveal_lookup_carries_message(info: &OffchainLookup, message_id: H256) -> bool {
    let Some(arguments) = info.call_data.get(CCS_REVEAL_LOOKUP_SELECTOR.len()..) else {
        return false;
    };
    match ethers::abi::decode(&[ethers::abi::ParamType::Bytes], arguments).as_deref() {
        Ok([ethers::abi::Token::Bytes(message)]) => {
            H256::from(ethers::utils::keccak256(message)) == message_id
        }
        _ => false,
    }
}

/// Why a reveal POST is neither signed nor sent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RevealPostRefusal {
    MissingOriginTxHash,
    NotForMessage,
}

impl RevealPostRefusal {
    fn reason(self) -> &'static str {
        match self {
            Self::MissingOriginTxHash => MISSING_REVEAL_ORIGIN_TX_HASH,
            Self::NotForMessage => REVEAL_NOT_FOR_MESSAGE,
        }
    }
}

/// A reveal POST is signed and sent only with the origin transaction hash and
/// only for the message being delivered: CCS refuses any other.
fn reveal_post_origin_tx_hash<'a>(
    info: &OffchainLookup,
    message_id: H256,
    origin_tx_hash: Option<&'a [u8]>,
) -> Result<&'a [u8], RevealPostRefusal> {
    let origin_tx_hash = origin_tx_hash.ok_or(RevealPostRefusal::MissingOriginTxHash)?;
    if !reveal_lookup_carries_message(info, message_id) {
        return Err(RevealPostRefusal::NotForMessage);
    }
    Ok(origin_tx_hash)
}

/// A relayer authentication signature and the time it was issued at.
#[derive(Clone, Debug, PartialEq, Eq)]
struct RequestSignature {
    signature: String,
    issued_at: u64,
    /// What is left of `CCIP_SIGNATURE_REUSE` once signing finished.
    reusable_for: Duration,
}

/// How long a signature can still be reused once signing finished at `signed_at`.
fn signature_reuse_remaining(signing_started: Instant, signed_at: Instant) -> Duration {
    CCIP_SIGNATURE_REUSE.saturating_sub(signed_at.saturating_duration_since(signing_started))
}

/// Expires a signature `CCIP_SIGNATURE_REUSE` after signing started, so time
/// spent signing counts toward the reuse window. The window is measured with
/// `Instant::now()` around signing, not with the cache's own clock.
struct SignatureReuseExpiry;

impl Expiry<(H160, H256), RequestSignature> for SignatureReuseExpiry {
    fn expire_after_create(
        &self,
        _key: &(H160, H256),
        value: &RequestSignature,
        _created_at: Instant,
    ) -> Option<Duration> {
        Some(value.reusable_for)
    }
}

/// Keyed by signer and the request's signing hash at `issued_at = 0`. Pending
/// retries (1 s apart) and concurrent identical lookups reuse one signature for
/// up to `CCIP_SIGNATURE_REUSE` instead of each calling KMS.
type CcipSignatureCache = Cache<(H160, H256), RequestSignature>;

static CCIP_SIGNATURE_CACHE: OnceLock<CcipSignatureCache> = OnceLock::new();

fn new_signature_cache() -> CcipSignatureCache {
    Cache::builder()
        .max_capacity(10_000)
        .expire_after(SignatureReuseExpiry)
        .build()
}

fn ccip_signature_cache() -> &'static CcipSignatureCache {
    CCIP_SIGNATURE_CACHE.get_or_init(new_signature_cache)
}

fn unix_now() -> Result<u64, std::time::SystemTimeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
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

fn allowed_ccip_url(
    url: &str,
    allowed_domains: &[String],
) -> Result<Url, (OffchainReadState, Box<MetadataBuildError>)> {
    let url = validate_ccip_url(url).map_err(|err| (OffchainReadState::UrlRejected, err))?;
    let ("https", Some(host)) = (url.scheme(), url.domain()) else {
        return Err((
            OffchainReadState::UrlRejected,
            Box::new(MetadataBuildError::FailedToBuild(
                "CCIP-read URL must use HTTPS and a DNS hostname".to_owned(),
            )),
        ));
    };
    if allowed_domains
        .iter()
        .any(|domain| domain.eq_ignore_ascii_case(host))
    {
        return Ok(url);
    }
    Err((
        OffchainReadState::DomainNotAllowed,
        Box::new(MetadataBuildError::FailedToBuild(format!(
            "CCIP-read host {host} is not in ccipReadAllowedDomains"
        ))),
    ))
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    pub origin_tx_hash: Option<String>,
    /// Signed with `signature`: the message being delivered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// Signed with `signature`: unix seconds at signing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issued_at: Option<u64>,
}

impl OffchainLookupRequestBody {
    /// The signed fields (`message_id`, `issued_at`) are sent only with a signature.
    fn new_post(
        sender: String,
        data: String,
        signature: Option<RequestSignature>,
        origin_tx_hash: Option<&[u8]>,
        message_id: H256,
    ) -> Self {
        let signed = signature.is_some();
        let (signature, issued_at) = signature.map(|s| (s.signature, s.issued_at)).unzip();
        Self {
            sender,
            data,
            signature,
            origin_tx_hash: origin_tx_hash.map(bytes_to_hex),
            message_id: signed.then(|| bytes_to_hex(message_id.as_bytes())),
            issued_at,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct OffchainResponse {
    data: String,
}

#[derive(Clone, Debug, new, Deref)]
pub struct CcipReadIsmMetadataBuilder {
    base: MessageMetadataBuilder,
}

impl CcipReadIsmMetadataBuilder {
    /// Generate a relayer authentication signature (EIP-191) over the framed
    /// request: url template, sender, call data, message id, origin tx hash and
    /// the time of signing.
    async fn generate_signature_hex<S: HyperlaneSigner>(
        signer: &S,
        info: &OffchainLookup,
        url: &str,
        message_id: H256,
        origin_tx_hash: &[u8],
    ) -> Result<RequestSignature, MetadataBuildError> {
        let mut request = OffchainLookupRequest {
            url: url.as_bytes(),
            sender: info.sender.into(),
            call_data: info.call_data.as_ref(),
            message_id,
            origin_tx_hash,
            issued_at: 0,
        };
        let cache_key = (signer.eth_address(), request.signing_hash());

        ccip_signature_cache()
            .try_get_with(cache_key, async {
                let signing_started = Instant::now();
                let issued_at = unix_now().map_err(|e| format!("System clock error: {e}"))?;
                request.issued_at = issued_at;

                request
                    .sign_offchain_lookup_request(signer)
                    .await
                    .map(|signature| RequestSignature {
                        signature,
                        issued_at,
                        reusable_for: signature_reuse_remaining(signing_started, Instant::now()),
                    })
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| MetadataBuildError::FailedToBuild(e.to_string()))
    }

    /// Only CCS reveal lookups are signed: a POST whose call data is a
    /// `getCallsFromRevealMessage` call, which CCS serves only together with
    /// the origin transaction hash and only for the message being delivered.
    /// Every other lookup is sent unsigned, and GET-style requests have no body
    /// to carry a signature.
    async fn generate_signature_for_post_request<S: HyperlaneSigner>(
        signer: Option<&S>,
        info: &OffchainLookup,
        url: &str,
        message_id: H256,
        origin_tx_hash: Option<&[u8]>,
    ) -> Result<Option<RequestSignature>, MetadataBuildError> {
        if url.contains("{data}") || !is_ccs_reveal_lookup(info) {
            return Ok(None);
        }
        let origin_tx_hash = reveal_post_origin_tx_hash(info, message_id, origin_tx_hash)
            .map_err(|refusal| MetadataBuildError::FailedToBuild(refusal.reason().to_owned()))?;

        match signer {
            Some(signer) => {
                Self::generate_signature_hex(signer, info, url, message_id, origin_tx_hash)
                    .await
                    .map(Some)
            }
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
        activity: &ReadActivity<'_>,
    ) -> Result<OffchainLookup, MetadataBuildError> {
        let message = activity.message;
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
                        activity.report(OffchainReadState::LookupReturnedNormally, None);
                        info!(message_id = ?message.id(), "incorrectly configured getOffchainVerifyInfo, expected revert");
                        return Err(MetadataBuildError::CouldNotFetch);
                    }
                    Err(raw_error) => {
                        let matching_regex = OFFCHAIN_LOOKUP_REGEX.as_ref().map_err(|err| {
                            activity.report(OffchainReadState::LookupFailed, None);
                            let msg = format!("Failed to parse regex: {err}");
                            MetadataBuildError::FailedToBuild(msg)
                        })?;
                        if let Some(matching) = &matching_regex.captures(&raw_error.to_string()) {
                            let hex_val = hex_decode(&matching[0][2..]).map_err(|err| {
                                activity.report(OffchainReadState::InvalidLookupRevert, None);
                                let msg = format!("Failed to decode hex from ISM response: {err}");
                                MetadataBuildError::FailedToBuild(msg)
                            })?;
                            OffchainLookup::decode(hex_val).map_err(|err| {
                                activity.report(OffchainReadState::InvalidLookupRevert, None);
                                let msg = format!("Failed to decode offchain lookup struct: {err}");
                                MetadataBuildError::FailedToBuild(msg)
                            })?
                        } else {
                            activity.report(OffchainReadState::LookupFailed, None);
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
    #[instrument(skip(self, message, _params))]
    async fn build(
        &self,
        ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let res = fetch_metadata(self, ism_address, message).await;

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

#[derive(Clone, Copy)]
struct ReadActivity<'a> {
    builder: &'a CcipReadIsmMetadataBuilder,
    message: &'a HyperlaneMessage,
    ism: H256,
    endpoint: Option<usize>,
    gateway: Option<&'a OffchainReadGateway>,
    attempt: u32,
}

impl ReadActivity<'_> {
    fn report(&self, state: OffchainReadState, http_status: Option<u16>) {
        self.builder.report_activity(
            self.message,
            Activity::OffchainRead {
                ism: self.ism,
                endpoint: self.endpoint,
                gateway: self.gateway.cloned(),
                attempt: self.attempt,
                state,
                http_status,
            },
        );
    }
}

async fn fetch_metadata(
    ism_builder: &CcipReadIsmMetadataBuilder,
    ism_address: H256,
    message: &HyperlaneMessage,
) -> Result<Metadata, MetadataBuildError> {
    let activity = ReadActivity {
        builder: ism_builder,
        message,
        ism: ism_address,
        endpoint: None,
        gateway: None,
        attempt: 0,
    };
    let ism = ism_builder
        .base
        .base_builder()
        .build_ccip_read_ism(ism_address)
        .await
        .map_err(|err| {
            activity.report(OffchainReadState::IsmBuildFailed, None);
            let msg = format!("Failed to build CCIP read ISM: {err}");
            MetadataBuildError::FailedToBuild(msg)
        })?;

    let info = ism_builder
        .call_get_offchain_verify_info(ism, &activity)
        .await?;

    let origin_tx_hash = ism_builder
        .base
        .base_builder()
        .retrieve_origin_tx_hash_by_message_id(message.id())
        .await
        .inspect(|hash| {
            if hash.is_none() {
                activity.report(OffchainReadState::OriginTransactionMissing, None);
            }
        })
        .map_err(|err| {
            activity.report(OffchainReadState::OriginTransactionLookupFailed, None);
            warn!(error = %err, "Error retrieving origin tx hash for message {:?}", message.id());
        })
        .ok()
        .flatten()
        .map(|h| h512_to_bytes(&h));
    let origin_tx_hash_hex = origin_tx_hash.as_deref().map(bytes_to_hex);
    tracing::debug!(
        message_id = ?message.id(),
        origin_tx_hash = ?origin_tx_hash_hex,
        found_in_db = origin_tx_hash.is_some(),
        "Origin tx hash lookup result",
    );

    if info.urls.is_empty() {
        activity.report(OffchainReadState::NoEndpoints, None);
    }
    let mut rejected_urls = 0usize;
    let mut denied_by_allowlist = false;
    for (endpoint, url) in info.urls.iter().enumerate() {
        // Retry this URL while attestation is pending (transient), up to 10 attempts at 1s intervals.
        // Move to the next URL only on hard failures.
        const MAX_PENDING_RETRIES: u32 = 10;
        let mut pending_attempts = 0u32;
        let gateway = OffchainReadGateway::from_template(url);
        tracing::info!(?ism_address, url, message_id = ?message.id(), "Fetching CCIP read offchain data");
        loop {
            let request_activity = ReadActivity {
                endpoint: Some(endpoint),
                gateway: gateway.as_ref(),
                attempt: pending_attempts.saturating_add(1),
                ..activity
            };
            match fetch_offchain_data(&request_activity, &info, url, origin_tx_hash.as_deref())
                .await
            {
                Ok(data) => {
                    tracing::info!(
                        ?ism_address,
                        url,
                        message_id = ?message.id(),
                        origin_tx_hash = ?origin_tx_hash_hex,
                        attempts = pending_attempts,
                        "Successfully fetched offchain lookup data"
                    );
                    return Ok(data);
                }
                Err(FetchOutcome::Pending(_)) if pending_attempts < MAX_PENDING_RETRIES => {
                    pending_attempts = pending_attempts.saturating_add(1);
                    tracing::debug!(
                        ?ism_address,
                        url,
                        message_id = ?message.id(),
                        origin_tx_hash = ?origin_tx_hash_hex,
                        attempt = pending_attempts,
                        max = MAX_PENDING_RETRIES,
                        "Attestation pending, retrying in 1s"
                    );
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(FetchOutcome::Pending(status)) => {
                    request_activity
                        .report(OffchainReadState::PendingRetriesExhausted, Some(status));
                    tracing::warn!(
                        ?ism_address,
                        url,
                        message_id = ?message.id(),
                        origin_tx_hash = ?origin_tx_hash_hex,
                        max = MAX_PENDING_RETRIES,
                        "Attestation still pending after max retries"
                    );
                    break;
                }
                Err(FetchOutcome::Failed(err)) => {
                    tracing::warn!(?ism_address, url, message_id = ?message.id(), origin_tx_hash = ?origin_tx_hash_hex, error = ?err, "Failed to fetch offchain data");
                    break;
                }
                Err(FetchOutcome::UrlRejected(state, err)) => {
                    rejected_urls = rejected_urls.saturating_add(1);
                    denied_by_allowlist |= state == OffchainReadState::DomainNotAllowed;
                    tracing::warn!(?ism_address, message_id = ?message.id(), error = %err, "Rejected CCIP-read endpoint");
                    break;
                }
            }
        }
    }

    if denied_by_allowlist && rejected_urls == info.urls.len() {
        Err(MetadataBuildError::CcipReadNotAllowed)
    } else {
        Err(MetadataBuildError::CouldNotFetch)
    }
}

/// Private result type for [`fetch_offchain_data`].
/// `Pending` signals a transient "not yet available" from the offchain server and
/// is only ever produced and consumed inside this module — it never escapes to
/// [`MetadataBuildError`].
enum FetchOutcome {
    Pending(u16),
    UrlRejected(OffchainReadState, Box<MetadataBuildError>),
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
    activity: &ReadActivity<'_>,
    info: &OffchainLookup,
    url: &str,
    origin_tx_hash: Option<&[u8]>,
) -> Result<Metadata, FetchOutcome> {
    let message_id = activity.message.id();
    let ism_builder = activity.builder;
    // Need to explicitly convert the sender H160 the hex because the `ToString` implementation
    // for `H160` truncates the output. (e.g. `0xc66a…7b6f` instead of returning
    // the full address)
    let sender_as_bytes = bytes_to_hex(info.sender.as_bytes());
    let data_as_bytes = info.call_data.to_string();
    let interpolated_url = url
        .replace("{sender}", &sender_as_bytes)
        .replace("{data}", &data_as_bytes);
    let allowed_domains = ism_builder.base_builder().ccip_read_allowed_domains();
    let interpolated_url =
        allowed_ccip_url(&interpolated_url, allowed_domains).map_err(|(state, reason)| {
            activity.report(state, None);
            FetchOutcome::UrlRejected(state, reason)
        })?;
    let client = ccip_http_client().map_err(|e| {
        activity.report(OffchainReadState::ClientFailed, None);
        FetchOutcome::from(*e)
    })?;
    // CCS refuses a reveal without the transaction that dispatched it or for
    // another message, so such a reveal POST is neither signed nor sent.
    // GET-style lookups are never signed and go ahead. This runs after URL
    // validation so a host outside the allowlist is still reported as such.
    if !url.contains("{data}") && is_ccs_reveal_lookup(info) {
        reveal_post_origin_tx_hash(info, message_id, origin_tx_hash).map_err(|refusal| {
            // A missing origin transaction hash is already reported for the message.
            if refusal == RevealPostRefusal::NotForMessage {
                activity.report(OffchainReadState::RevealNotForMessage, None);
            }
            FetchOutcome::Failed(MetadataBuildError::FailedToBuild(
                refusal.reason().to_owned(),
            ))
        })?;
    }

    // Validate the destination before invoking a remote signer.
    // The message id is the delivered message's, never taken from the lookup's
    // call data, so a server can check that the lookup describes this message.
    let maybe_signature = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
        ism_builder.base.base_builder().get_signer(),
        info,
        url,
        message_id,
        origin_tx_hash,
    )
    .await
    .inspect_err(|_| {
        activity.report(OffchainReadState::SigningFailed, None);
    })?;

    let request = if !url.contains("{data}") {
        let body = OffchainLookupRequestBody::new_post(
            sender_as_bytes,
            data_as_bytes,
            maybe_signature,
            origin_tx_hash,
            message_id,
        );
        tracing::debug!(
            url = %interpolated_url,
            ?message_id,
            "Sending POST request to offchain lookup server"
        );
        client
            .request(Method::POST, interpolated_url)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
    } else {
        client.request(Method::GET, interpolated_url)
    };
    let res = request
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT))
        .send()
        .await
        .map_err(|err| {
            activity.report(
                if err.is_timeout() {
                    OffchainReadState::RequestTimeout
                } else {
                    OffchainReadState::RequestFailed
                },
                None,
            );
            MetadataBuildError::FailedToBuild(format!("Offchain lookup request failed: {err}"))
        })?;

    let status = res.status();

    let response_body = read_response_body(res).await.inspect_err(|_| {
        activity.report(OffchainReadState::BodyReadFailed, Some(status.as_u16()));
    })?;
    tracing::debug!(
        response = response_body,
        status = status.as_u16(),
        ?message_id,
        "Received response from offchain lookup server"
    );

    decode_offchain_response(activity, status, &response_body).map_err(|outcome| *outcome)
}

fn decode_offchain_response(
    activity: &ReadActivity<'_>,
    status: reqwest::StatusCode,
    response_body: &str,
) -> Result<Metadata, Box<FetchOutcome>> {
    if body_signals_pending(response_body) {
        // Keep the transition to pending, not every one-second internal retry.
        if activity.attempt == 1 {
            activity.report(OffchainReadState::Pending, Some(status.as_u16()));
        }
        return Err(Box::new(FetchOutcome::Pending(status.as_u16())));
    }

    // A 404 without an explicit pending response is a hard failure.
    if status == reqwest::StatusCode::NOT_FOUND {
        activity.report(OffchainReadState::InvalidResponse, Some(status.as_u16()));
        return Err(Box::new(FetchOutcome::Failed(
            MetadataBuildError::FailedToBuild(format!(
                "Offchain lookup server returned 404: {response_body}"
            )),
        )));
    }

    let json: OffchainResponse = serde_json::from_str(response_body).map_err(|err| {
        activity.report(OffchainReadState::InvalidResponse, Some(status.as_u16()));
        let error_msg = format!(
            "Failed to parse offchain lookup server json response: ({err}) ({response_body})"
        );
        Box::new(FetchOutcome::Failed(MetadataBuildError::FailedToBuild(
            error_msg,
        )))
    })?;

    decode_response_data(&json.data)
        .inspect(|metadata| {
            activity.report(
                OffchainReadState::Succeeded {
                    bytes: metadata.len(),
                    keccak256: ethers::utils::keccak256(metadata.as_ref()).into(),
                },
                Some(status.as_u16()),
            )
        })
        .map_err(|e| {
            activity.report(OffchainReadState::InvalidResponse, Some(status.as_u16()));
            Box::new(FetchOutcome::from(*e))
        })
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
    use hyperlane_core::{HyperlaneSignerError, Signature as HyperlaneSignature, U256};
    use hyperlane_ethereum::Signers;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    use super::*;

    #[test]
    fn offchain_lookup_regex_matches_repeated_reverts() {
        let regex = OFFCHAIN_LOOKUP_REGEX.as_ref().expect("valid static regex");
        for _ in 0..3 {
            assert_eq!(
                regex
                    .find("execution reverted: 0xAbCd0123")
                    .map(|m| m.as_str()),
                Some("0xAbCd0123")
            );
            assert!(regex.find("execution reverted without data").is_none());
        }
    }

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
    #[ignore = "requires the local HTTPS CCS + PostgreSQL fixture server (CCS_E2E_FIXTURES)"]
    async fn ccs_e2e_post_authentication() -> eyre::Result<()> {
        #[derive(Deserialize)]
        struct Fixtures {
            base: String,
            ca: String,
            sender: String,
            cases: Vec<Case>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Case {
            name: String,
            lookup_data: String,
            expected_metadata: String,
            origin_tx_hash: Option<String>,
            message_id: H256,
        }
        let fixtures: Fixtures =
            serde_json::from_slice(&std::fs::read(std::env::var("CCS_E2E_FIXTURES")?)?)?;
        let url = format!("{}/getCallsFromRevealMessage", fixtures.base);
        let client = Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(&std::fs::read(
                fixtures.ca,
            )?)?)
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        for case in fixtures
            .cases
            .iter()
            .filter(|c| c.name.to_lowercase().contains("evm"))
        {
            let origin_tx_hash = hex::decode(
                case.origin_tx_hash
                    .as_deref()
                    .ok_or_else(|| eyre::eyre!("{} fixture has no originTxHash", case.name))?
                    .trim_start_matches("0x"),
            )?;
            for key_byte in [1u8, 2, 3] {
                let signer = Signers::Local(ethers::signers::LocalWallet::from_str(&hex::encode(
                    [key_byte; 32],
                ))?);
                let info = OffchainLookup {
                    sender: EthersH160::from_str(&fixtures.sender)?,
                    call_data: hex::decode(case.lookup_data.trim_start_matches("0x"))?.into(),
                    urls: vec![url.clone()],
                    callback_function: [0; 4],
                    extra_data: vec![].into(),
                };
                // The relayer refuses to sign a reveal without the origin transaction hash.
                assert_eq!(
                    CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
                        Some(&signer),
                        &info,
                        &url,
                        case.message_id,
                        None,
                    )
                    .await,
                    Err(MetadataBuildError::FailedToBuild(
                        MISSING_REVEAL_ORIGIN_TX_HASH.to_owned()
                    )),
                    "{} signer {key_byte}",
                    case.name
                );
                // A body signed over an empty hash and sent without one.
                let signature_without_hash = CcipReadIsmMetadataBuilder::generate_signature_hex(
                    &signer,
                    &info,
                    &url,
                    case.message_id,
                    &[],
                )
                .await?;
                let signature = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
                    Some(&signer),
                    &info,
                    &url,
                    case.message_id,
                    Some(&origin_tx_hash),
                )
                .await?
                .ok_or_else(|| eyre::eyre!("{} reveal lookup was not signed", case.name))?;
                let allowed =
                    key_byte != 3 && (!case.name.starts_with("restricted") || key_byte == 2);

                // The origin transaction hash is part of the credentials, so
                // CCS refuses a body without one before checking the signer.
                let without_hash = OffchainLookupRequestBody::new_post(
                    fixtures.sender.clone(),
                    case.lookup_data.clone(),
                    Some(signature_without_hash),
                    None,
                    case.message_id,
                );
                let response = client.post(&url).json(&without_hash).send().await?;
                assert_eq!(
                    response.status().as_u16(),
                    401,
                    "{} signer {key_byte} without origin_tx_hash",
                    case.name
                );

                let body = OffchainLookupRequestBody::new_post(
                    fixtures.sender.clone(),
                    case.lookup_data.clone(),
                    Some(signature),
                    Some(&origin_tx_hash),
                    case.message_id,
                );
                let response = client.post(&url).json(&body).send().await?;
                assert_eq!(
                    response.status().as_u16(),
                    if allowed { 200 } else { 403 },
                    "{} signer {key_byte}",
                    case.name
                );
                if allowed {
                    assert_eq!(
                        response.json::<OffchainResponse>().await?.data,
                        case.expected_metadata
                    );
                }
            }
        }
        Ok(())
    }

    const MESSAGE_ID: H256 = H256::repeat_byte(0x77);
    const ORIGIN_TX_HASH: [u8; 32] = [0x88; 32];

    async fn sign(
        signer: &CountingSigner,
        info: &OffchainLookup,
        url: &str,
    ) -> Result<RequestSignature, MetadataBuildError> {
        CcipReadIsmMetadataBuilder::generate_signature_hex(
            signer,
            info,
            url,
            MESSAGE_ID,
            &ORIGIN_TX_HASH,
        )
        .await
    }

    #[tokio::test]
    async fn test_generate_signature_hex() -> eyre::Result<()> {
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
            sender: EthersH160::from_str("4ee6ecad1c2dae9f525404de8555724e3c35d07b")?,
            urls: vec![url.clone()],
            callback_function: [0, 0, 0, 0],
            extra_data: vec![].into(),
        };

        let before = unix_now()?;
        let signed = CcipReadIsmMetadataBuilder::generate_signature_hex(
            &signer,
            &info,
            &url,
            MESSAGE_ID,
            &ORIGIN_TX_HASH,
        )
        .await?;
        assert!((before..=unix_now()?).contains(&signed.issued_at));

        // 65 bytes = 130 hex chars + 2 for 0x
        assert_eq!(signed.signature.len(), 132);
        let hash = OffchainLookupRequest {
            url: url.as_bytes(),
            sender: info.sender.into(),
            call_data: info.call_data.as_ref(),
            message_id: MESSAGE_ID,
            origin_tx_hash: &ORIGIN_TX_HASH,
            issued_at: signed.issued_at,
        }
        .signing_hash();
        let signature = ethers::types::Signature::from_str(&signed.signature)?;
        let recovered = signature.recover(ethers::utils::hash_message(hash.as_bytes()))?;
        assert_eq!(H160::from(recovered), signer.eth_address());
        Ok(())
    }

    #[test]
    fn post_body_carries_the_signed_fields_only_with_a_signature() {
        let signature = RequestSignature {
            signature: "0xsig".to_owned(),
            issued_at: 1_700_000_000,
            reusable_for: CCIP_SIGNATURE_REUSE,
        };
        let signed = serde_json::to_value(OffchainLookupRequestBody::new_post(
            "0xsender".to_owned(),
            "0xdata".to_owned(),
            Some(signature),
            Some(&ORIGIN_TX_HASH),
            MESSAGE_ID,
        ))
        .unwrap();
        assert_eq!(
            signed,
            serde_json::json!({
                "sender": "0xsender",
                "data": "0xdata",
                "signature": "0xsig",
                "origin_tx_hash": bytes_to_hex(&ORIGIN_TX_HASH),
                "message_id": bytes_to_hex(MESSAGE_ID.as_bytes()),
                "issued_at": 1_700_000_000u64,
            })
        );

        let unsigned = serde_json::to_value(OffchainLookupRequestBody::new_post(
            "0xsender".to_owned(),
            "0xdata".to_owned(),
            None,
            None,
            MESSAGE_ID,
        ))
        .unwrap();
        assert_eq!(
            unsigned,
            serde_json::json!({
                "sender": "0xsender",
                "data": "0xdata",
                "origin_tx_hash": null,
            })
        );
    }

    #[tokio::test]
    async fn signature_cache_reuses_identical_signature() {
        let signer = CountingSigner::new(0x10);
        let url = "https://cache-reuse.example/lookup";
        let info = test_offchain_lookup(b"cache-reuse", 0x11, url);

        let first = sign(&signer, &info, url).await.unwrap();
        let second = sign(&signer, &info, url).await.unwrap();

        // Including its issue time: the reused request is the one that was signed.
        assert_eq!(first, second);
        assert_eq!(signer.calls(), 1);
    }

    #[tokio::test]
    async fn signature_cache_key_includes_signer_and_every_signed_field() {
        let signer = CountingSigner::new(0x20);
        let other_signer = CountingSigner::new(0x21);
        let url = "https://cache-key.example/lookup";
        let info = test_offchain_lookup(b"cache-key", 0x22, url);
        let other_data = test_offchain_lookup(b"other-data", 0x22, url);
        let other_sender = test_offchain_lookup(b"cache-key", 0x23, url);

        sign(&signer, &info, url).await.unwrap();
        sign(&signer, &other_data, url).await.unwrap();
        sign(&signer, &other_sender, url).await.unwrap();
        sign(&signer, &info, "https://other-url.example/lookup")
            .await
            .unwrap();
        for (message_id, origin_tx_hash) in [
            (H256::repeat_byte(0x78), &ORIGIN_TX_HASH[..]),
            (MESSAGE_ID, &[0x89; 32][..]),
            (MESSAGE_ID, &[0x88; 64][..]),
        ] {
            CcipReadIsmMetadataBuilder::generate_signature_hex(
                &signer,
                &info,
                url,
                message_id,
                origin_tx_hash,
            )
            .await
            .unwrap();
        }
        sign(&other_signer, &info, url).await.unwrap();

        assert_eq!(signer.calls(), 7);
        assert_eq!(other_signer.calls(), 1);
    }

    #[tokio::test]
    async fn signature_cache_coalesces_concurrent_requests() {
        let signer = CountingSigner::delayed(0x30);
        let url = "https://cache-concurrent.example/lookup";
        let info = test_offchain_lookup(b"cache-concurrent", 0x31, url);

        let results = join_all((0..8).map(|_| sign(&signer, &info, url))).await;

        assert!(results.iter().all(Result::is_ok));
        assert_eq!(signer.calls(), 1);
    }

    #[tokio::test]
    async fn signature_cache_does_not_cache_errors() {
        let signer = CountingSigner::failing_once(0x40);
        let url = "https://cache-error.example/lookup";
        let info = test_offchain_lookup(b"cache-error", 0x41, url);

        assert!(sign(&signer, &info, url).await.is_err());
        assert!(sign(&signer, &info, url).await.is_ok());
        assert!(sign(&signer, &info, url).await.is_ok());

        assert_eq!(signer.calls(), 2);
    }

    const REVEAL_MESSAGE: &[u8] = b"reveal-message";

    fn reveal_message_id() -> H256 {
        H256::from(ethers::utils::keccak256(REVEAL_MESSAGE))
    }

    fn reveal_call_data(message: &[u8]) -> Vec<u8> {
        [
            &CCS_REVEAL_LOOKUP_SELECTOR[..],
            &ethers::abi::encode(&[ethers::abi::Token::Bytes(message.to_vec())]),
        ]
        .concat()
    }

    /// A reveal lookup for `REVEAL_MESSAGE`, whose id is `reveal_message_id()`.
    fn ccs_reveal_lookup(sender_byte: u8, url: &str) -> OffchainLookup {
        test_offchain_lookup(&reveal_call_data(REVEAL_MESSAGE), sender_byte, url)
    }

    #[test]
    fn signature_reuse_counts_the_time_spent_signing() {
        let signing_started = Instant::now();
        let after = |secs| signing_started + Duration::from_secs(secs);

        assert_eq!(
            signature_reuse_remaining(signing_started, signing_started),
            CCIP_SIGNATURE_REUSE
        );
        assert_eq!(
            signature_reuse_remaining(signing_started, after(4)),
            Duration::from_secs(1)
        );
        // Signing that outlasts the window leaves nothing to reuse.
        assert_eq!(
            signature_reuse_remaining(signing_started, after(5)),
            Duration::ZERO
        );
        assert_eq!(
            signature_reuse_remaining(signing_started, after(20)),
            Duration::ZERO
        );
    }

    #[tokio::test]
    async fn signature_cache_keeps_a_signature_only_for_its_remaining_window() {
        let cache = new_signature_cache();
        let signature = |reusable_for| RequestSignature {
            signature: "0xsig".to_owned(),
            issued_at: 1_700_000_000,
            reusable_for,
        };
        let spent = (H160::repeat_byte(0x01), H256::repeat_byte(0x01));
        let fresh = (H160::repeat_byte(0x02), H256::repeat_byte(0x02));

        cache.insert(spent, signature(Duration::ZERO)).await;
        cache.insert(fresh, signature(CCIP_SIGNATURE_REUSE)).await;

        assert_eq!(cache.get(&spent).await, None);
        assert!(cache.get(&fresh).await.is_some());
    }

    #[tokio::test]
    async fn reveal_for_another_message_is_not_signed() {
        let signer = CountingSigner::new(0x80);
        let url = "https://post.example/lookup";

        for (name, call_data, message_id) in [
            (
                "another message",
                reveal_call_data(REVEAL_MESSAGE),
                MESSAGE_ID,
            ),
            (
                "malformed arguments",
                [&CCS_REVEAL_LOOKUP_SELECTOR[..], &[0x99; 64]].concat(),
                reveal_message_id(),
            ),
            (
                "no arguments",
                CCS_REVEAL_LOOKUP_SELECTOR.to_vec(),
                reveal_message_id(),
            ),
        ] {
            let result = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
                Some(&signer),
                &test_offchain_lookup(&call_data, 0x81, url),
                url,
                message_id,
                Some(&ORIGIN_TX_HASH),
            )
            .await;

            assert_eq!(
                result,
                Err(MetadataBuildError::FailedToBuild(
                    REVEAL_NOT_FOR_MESSAGE.to_owned()
                )),
                "{name}"
            );
        }
        assert_eq!(signer.calls(), 0);
    }

    #[test]
    fn ccs_reveal_lookup_selector_matches_the_service_interface() {
        assert_eq!(
            CCS_REVEAL_LOOKUP_SELECTOR,
            ethers::utils::id("getCallsFromRevealMessage(bytes)")
        );
    }

    #[tokio::test]
    async fn only_ccs_reveal_lookups_are_signed() {
        let signer = CountingSigner::new(0x60);
        let url = "https://post.example/lookup";
        let other_selector = [&[0x2b, 0x4b, 0x00, 0xef][..], &[0x99; 64]].concat();

        for info in [
            test_offchain_lookup(&other_selector, 0x61, url),
            test_offchain_lookup(&CCS_REVEAL_LOOKUP_SELECTOR[..3], 0x61, url),
            test_offchain_lookup(b"", 0x61, url),
        ] {
            let signature = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
                Some(&signer),
                &info,
                url,
                MESSAGE_ID,
                Some(&ORIGIN_TX_HASH),
            )
            .await
            .unwrap();
            assert_eq!(signature, None);
        }
        assert_eq!(signer.calls(), 0);

        let signature = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
            Some(&signer),
            &ccs_reveal_lookup(0x61, url),
            url,
            reveal_message_id(),
            Some(&ORIGIN_TX_HASH),
        )
        .await
        .unwrap();
        assert!(signature.is_some());
        assert_eq!(signer.calls(), 1);
    }

    #[tokio::test]
    async fn reveal_signature_requires_the_origin_tx_hash() {
        let signer = CountingSigner::new(0x70);
        let url = "https://post.example/lookup";

        let result = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
            Some(&signer),
            &ccs_reveal_lookup(0x71, url),
            url,
            MESSAGE_ID,
            None,
        )
        .await;

        assert_eq!(
            result,
            Err(MetadataBuildError::FailedToBuild(
                MISSING_REVEAL_ORIGIN_TX_HASH.to_owned()
            ))
        );
        assert_eq!(signer.calls(), 0);
    }

    #[tokio::test]
    async fn get_request_does_not_generate_signature() {
        let signer = CountingSigner::new(0x50);
        let url = "https://get.example/{data}";
        let info = ccs_reveal_lookup(0x51, url);

        let signature = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
            Some(&signer),
            &info,
            url,
            MESSAGE_ID,
            Some(&ORIGIN_TX_HASH),
        )
        .await
        .unwrap();

        assert_eq!(signature, None);
        assert_eq!(signer.calls(), 0);
    }

    /// A CCIP-read ISM whose `getOffchainVerifyInfo` fails with `revert`.
    #[derive(Debug)]
    struct RevertingCcipReadIsm {
        address: H256,
        domain: hyperlane_core::HyperlaneDomain,
        revert: String,
    }

    impl hyperlane_core::HyperlaneChain for RevertingCcipReadIsm {
        fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
            &self.domain
        }

        fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
            unimplemented!()
        }
    }

    impl hyperlane_core::HyperlaneContract for RevertingCcipReadIsm {
        fn address(&self) -> H256 {
            self.address
        }
    }

    #[async_trait]
    impl CcipReadIsm for RevertingCcipReadIsm {
        async fn get_offchain_verify_info(
            &self,
            _message: Vec<u8>,
        ) -> hyperlane_core::ChainResult<()> {
            Err(hyperlane_core::ChainCommunicationError::from_other_str(
                &self.revert,
            ))
        }
    }

    /// Builds the error text an ISM implementation produces from a revert payload.
    type FormatRevert = fn(&str) -> String;

    /// The destinations whose ISMs surface an `OffchainLookup` revert, each with
    /// the error text its ISM implementation produces from the revert payload.
    fn ccip_read_destinations() -> Vec<(hyperlane_core::HyperlaneDomain, FormatRevert)> {
        use hyperlane_core::{
            HyperlaneDomain, HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack,
            HyperlaneDomainType, KnownHyperlaneDomain,
        };
        vec![
            (
                HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum),
                |payload| format!("execution reverted: {payload}"),
            ),
            (
                // `TronCcipReadIsm` returns the revert payload as a bare "0x{hex}" error.
                HyperlaneDomain::Unknown {
                    domain_id: 728126428,
                    domain_name: "tron".to_owned(),
                    domain_type: HyperlaneDomainType::Mainnet,
                    domain_protocol: HyperlaneDomainProtocol::Tron,
                    domain_technical_stack: HyperlaneDomainTechnicalStack::Other,
                },
                str::to_owned,
            ),
        ]
    }

    /// The only host [`lookup_with_call_data`] allows. It resolves to a loopback
    /// address, so a request to it fails without leaving the machine.
    const ALLOWED_LOOKUP_HOST: &str = "localhost";
    const ALLOWED_LOOKUP_URL: &str = "https://localhost/lookup";
    const DISALLOWED_LOOKUP_URL: &str = "https://ccs.example/lookup";

    /// Fetches metadata from the ISM at `ism` on `domain`, whose lookup names
    /// `sender`, `urls` and `call_data`, and returns its error and read states.
    async fn lookup_with_call_data(
        domain: hyperlane_core::HyperlaneDomain,
        format_revert: FormatRevert,
        ism: H256,
        sender: EthersH160,
        urls: Vec<String>,
        call_data: Vec<u8>,
        origin_tx_hash: Option<hyperlane_core::H512>,
    ) -> (MetadataBuildError, Vec<String>) {
        use crate::test_utils::mock_base_builder::build_mock_base_builder;
        use ethers::abi::AbiEncode;

        let mut base = build_mock_base_builder(domain.clone(), domain.clone());
        base.responses.ccip_read_allowed_domains = vec![ALLOWED_LOOKUP_HOST.to_owned()];
        let base = Arc::new(base);
        *base.responses.origin_tx_hash.lock().expect("lock") = origin_tx_hash;
        let lookup = OffchainLookup {
            sender,
            urls,
            call_data: call_data.into(),
            callback_function: [0; 4],
            extra_data: Default::default(),
        };
        base.responses
            .build_ccip_read_ism
            .lock()
            .expect("lock")
            .push_back(Ok(Box::new(RevertingCcipReadIsm {
                address: ism,
                domain,
                revert: format_revert(&bytes_to_hex(&lookup.encode())),
            })));
        let builder = CcipReadIsmMetadataBuilder::new(MessageMetadataBuilder {
            node_id: "test-root".to_owned(),
            base: base.clone(),
            app_context: None,
            root_ism: ism,
            signature_polling: false,
            signature_poll_retry: None,
            max_ism_depth: 5,
            max_ism_count: 10,
        });

        let error = fetch_metadata(&builder, ism, &HyperlaneMessage::default())
            .await
            .expect_err("the lookup is not served");

        let activities = base.requests.activities.lock().expect("lock");
        let states = activities
            .iter()
            .map(|(_, activity)| {
                serde_json::to_value(activity).expect("serialize")["state"].to_string()
            })
            .collect();
        (error, states)
    }

    /// An ISM address, widened to 32 bytes, and the same address as a lookup sender.
    fn queried_ism() -> (H256, EthersH160) {
        let address: EthersH160 = "4ee6ecad1c2dae9f525404de8555724e3c35d07b"
            .parse()
            .expect("address");
        (H256::from(address), address)
    }

    #[tokio::test]
    async fn reveal_post_without_origin_tx_hash_is_not_signed_or_sent() {
        let (ism, sender) = queried_ism();
        for (domain, format_revert) in ccip_read_destinations() {
            let name = domain.name().to_owned();
            // The mock base builder has no origin transaction hash for the message.
            let (error, states) = lookup_with_call_data(
                domain,
                format_revert,
                ism,
                sender,
                vec![ALLOWED_LOOKUP_URL.to_owned()],
                [&CCS_REVEAL_LOOKUP_SELECTOR[..], &[0x99; 64]].concat(),
                None,
            )
            .await;

            // Refused after URL validation, before signing and the request.
            assert_eq!(error, MetadataBuildError::CouldNotFetch, "{name}");
            assert_eq!(states, vec!["\"origin_transaction_missing\""], "{name}");
        }
    }

    #[tokio::test]
    async fn reveal_post_for_another_message_is_reported_and_not_signed_or_sent() {
        let (ism, sender) = queried_ism();
        let (domain, format_revert) = ccip_read_destinations()
            .into_iter()
            .next()
            .expect("an EVM destination");
        let delivered = RawHyperlaneMessage::from(&HyperlaneMessage::default());
        let urls = vec![ALLOWED_LOOKUP_URL.to_owned()];
        let origin_tx_hash = Some(hyperlane_core::H512::repeat_byte(0x88));

        // The lookups are read for `HyperlaneMessage::default()`.
        let (error, states) = lookup_with_call_data(
            domain.clone(),
            format_revert,
            ism,
            sender,
            urls.clone(),
            reveal_call_data(REVEAL_MESSAGE),
            origin_tx_hash,
        )
        .await;
        assert_eq!(error, MetadataBuildError::CouldNotFetch);
        // Refused after URL validation, before signing and the request.
        assert_eq!(states, vec!["\"reveal_not_for_message\""]);

        let (_, states) = lookup_with_call_data(
            domain,
            format_revert,
            ism,
            sender,
            urls,
            reveal_call_data(&delivered),
            origin_tx_hash,
        )
        .await;
        // The delivered message's reveal goes on to the request, which fails
        // because the allowed host resolves to a loopback address.
        assert_eq!(states, vec!["\"request_failed\""]);
    }

    #[tokio::test]
    async fn refused_reveal_post_to_a_disallowed_host_is_not_allowed() {
        let (ism, sender) = queried_ism();
        let (domain, format_revert) = ccip_read_destinations()
            .into_iter()
            .next()
            .expect("an EVM destination");
        let cases = [
            (
                None,
                vec!["\"origin_transaction_missing\"", "\"domain_not_allowed\""],
            ),
            (
                Some(hyperlane_core::H512::repeat_byte(0x88)),
                vec!["\"domain_not_allowed\""],
            ),
        ];
        for (origin_tx_hash, expected_states) in cases {
            // The lookups are read for `HyperlaneMessage::default()`.
            let (error, states) = lookup_with_call_data(
                domain.clone(),
                format_revert,
                ism,
                sender,
                vec![DISALLOWED_LOOKUP_URL.to_owned()],
                reveal_call_data(REVEAL_MESSAGE),
                origin_tx_hash,
            )
            .await;

            // The allowlist rejects the host before the reveal is checked, so
            // the message is not retried.
            assert_eq!(error, MetadataBuildError::CcipReadNotAllowed);
            assert_eq!(states, expected_states);
        }
    }

    #[tokio::test]
    async fn reveal_get_without_origin_tx_hash_is_still_tried() {
        let (ism, sender) = queried_ism();
        let (domain, format_revert) = ccip_read_destinations()
            .into_iter()
            .next()
            .expect("an EVM destination");
        // The mock base builder has no origin transaction hash for the message.
        let (_, states) = lookup_with_call_data(
            domain,
            format_revert,
            ism,
            sender,
            vec![
                ALLOWED_LOOKUP_URL.to_owned(),
                "https://127.0.0.1/lookup/{data}".to_owned(),
            ],
            [&CCS_REVEAL_LOOKUP_SELECTOR[..], &[0x99; 64]].concat(),
            None,
        )
        .await;

        // The POST is skipped; the unsigned GET goes on to URL validation.
        assert_eq!(
            states,
            vec!["\"origin_transaction_missing\"", "\"url_rejected\""]
        );
    }

    #[test]
    fn activity_distinguishes_pending_and_bad_responses_without_exposing_bodies() {
        use crate::test_utils::mock_base_builder::MockBaseMetadataBuilder;
        let base = Arc::new(MockBaseMetadataBuilder::default());
        let builder = CcipReadIsmMetadataBuilder::new(MessageMetadataBuilder {
            node_id: "test-root".to_owned(),
            base: base.clone(),
            app_context: None,
            root_ism: H256::repeat_byte(1),
            signature_polling: false,
            signature_poll_retry: None,
            max_ism_depth: 5,
            max_ism_count: 10,
        });
        let message = HyperlaneMessage::default();
        let gateway = OffchainReadGateway::from_template("https://user:private-password@lookup.example:8443/%7Bsender%7D/{data}?token=private-password#private-password").expect("HTTP gateway template");
        let activity = ReadActivity {
            builder: &builder,
            message: &message,
            ism: H256::repeat_byte(1),
            endpoint: Some(0),
            gateway: Some(&gateway),
            attempt: 1,
        };
        for (status, body, expected) in [
            (200, r#"{"status":"pending"}"#, "pending"),
            (404, r#"{"error":"CCTP attestation not found"}"#, "pending"),
            (
                404,
                r#"{"error":"private-password in upstream response"}"#,
                "invalid_response",
            ),
            (
                401,
                "private-password in malformed JSON",
                "invalid_response",
            ),
            (200, r#"{"data":"private-password"}"#, "invalid_response"),
        ] {
            base.requests
                .activities
                .lock()
                .expect("activity lock")
                .clear();
            let result = decode_offchain_response(
                &activity,
                reqwest::StatusCode::from_u16(status).expect("status"),
                body,
            );
            if expected == "pending" {
                assert!(
                    matches!(result, Err(outcome) if matches!(*outcome, FetchOutcome::Pending(code) if code == status))
                );
            } else {
                assert!(
                    matches!(result, Err(outcome) if matches!(*outcome, FetchOutcome::Failed(_)))
                );
            }
            let events = base.requests.activities.lock().expect("activity lock");
            assert_eq!(events.len(), 1);
            let (id, event) = events.first().expect("event");
            assert_eq!(*id, message.id());
            let event = serde_json::to_value(event).expect("serialize");
            assert_eq!(event["state"], expected);
            assert_eq!(event["http_status"], status);
            assert_eq!(event["attempt"], 1);
            assert_eq!(event["hostname"], "lookup.example");
            assert_eq!(
                event["url_template"],
                "https://lookup.example:8443/%7bsender%7d/{data}"
            );
            assert!(!event.to_string().contains("private-password"));
        }
        base.requests
            .activities
            .lock()
            .expect("activity lock")
            .clear();
        for attempt in 1..=11 {
            let retry = ReadActivity {
                attempt,
                ..activity
            };
            assert!(decode_offchain_response(
                &retry,
                reqwest::StatusCode::OK,
                r#"{"status":"pending"}"#
            )
            .is_err());
        }
        assert_eq!(
            base.requests
                .activities
                .lock()
                .expect("activity lock")
                .len(),
            1
        );
        let final_attempt = ReadActivity {
            attempt: 11,
            ..activity
        };
        assert!(decode_offchain_response(
            &final_attempt,
            reqwest::StatusCode::OK,
            r#"{"data":"0x1234"}"#
        )
        .is_ok());
        let events = base.requests.activities.lock().expect("activity lock");
        assert_eq!(events.len(), 2);
        let outcome = serde_json::to_value(&events[1].1).expect("serialize outcome");
        assert_eq!(outcome["state"], "succeeded");
        assert_eq!(outcome["attempt"], 11);
        assert_eq!(outcome["http_status"], 200);
        assert_eq!(outcome["result"]["bytes"], 2);
        assert_eq!(
            outcome["result"]["keccak256"],
            bytes_to_hex(&ethers::utils::keccak256([0x12, 0x34]))
        );
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
    fn ccip_read_requires_an_exact_allowed_domain() {
        let allowed = ["Lookup.Example".to_owned(), "8.8.8.8".to_owned()];
        let url = "https://lookup.example/metadata";
        assert!(allowed_ccip_url(url, &allowed).is_ok());
        let (state, error) = allowed_ccip_url(url, &[]).unwrap_err();
        assert_eq!(state, OffchainReadState::DomainNotAllowed);
        assert!(matches!(*error, MetadataBuildError::FailedToBuild(reason)
            if reason == "CCIP-read host lookup.example is not in ccipReadAllowedDomains"));
        for url in [
            "https://sub.lookup.example/",
            "https://lookup.example.other/",
            "https://other.example/lookup.example",
        ] {
            let (state, _) = allowed_ccip_url(url, &allowed).unwrap_err();
            assert_eq!(state, OffchainReadState::DomainNotAllowed, "{url}");
        }
        for url in [
            "http://lookup.example/metadata",
            "https://8.8.8.8/",
            "https://127.0.0.1/",
        ] {
            let (state, _) = allowed_ccip_url(url, &allowed).unwrap_err();
            assert_eq!(state, OffchainReadState::UrlRejected, "{url}");
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
