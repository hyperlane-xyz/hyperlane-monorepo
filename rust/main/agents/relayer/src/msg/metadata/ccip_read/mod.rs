#![allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue

use std::{sync::OnceLock, time::Duration};

use async_trait::async_trait;
use cache_types::SerializedOffchainLookup;
use derive_more::Deref;
use derive_new::new;
use ethers::{abi::AbiDecode, core::utils::hex::decode as hex_decode};
use hyperlane_base::cache::FunctionCallCache;
use moka::future::Cache;
use regex::{Regex, RegexSet, RegexSetBuilder};
use reqwest::{header::CONTENT_TYPE, Client, Method};
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

    let ccip_url_regex = create_ccip_url_regex();

    for url in info.urls.iter() {
        if ccip_url_regex.is_match(url) {
            tracing::warn!(?ism_address, url, message_id = ?message.id(), "Suspicious CCIP read url");
            continue;
        }

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

/// Fetch data from offchain lookup server
async fn fetch_offchain_data(
    ism_builder: &CcipReadIsmMetadataBuilder,
    info: &OffchainLookup,
    url: &str,
    origin_tx_hash: Option<String>,
    message_id: H256,
) -> Result<Metadata, FetchOutcome> {
    // Compute relayer authentication signature via EIP-191
    let maybe_signature_hex = CcipReadIsmMetadataBuilder::generate_signature_for_post_request(
        ism_builder.base.base_builder().get_signer(),
        info,
        url,
    )
    .await?;

    // Need to explicitly convert the sender H160 the hex because the `ToString` implementation
    // for `H160` truncates the output. (e.g. `0xc66a…7b6f` instead of returning
    // the full address)
    let sender_as_bytes = bytes_to_hex(info.sender.as_bytes());
    let data_as_bytes = info.call_data.to_string();
    let interpolated_url = url
        .replace("{sender}", &sender_as_bytes)
        .replace("{data}", &data_as_bytes);
    let res = if !url.contains("{data}") {
        let body = OffchainLookupRequestBody {
            sender: sender_as_bytes,
            data: data_as_bytes,
            signature: maybe_signature_hex,
            origin_tx_hash,
        };
        tracing::debug!(
            url = interpolated_url,
            ?body,
            ?message_id,
            "Sending POST request to offchain lookup server"
        );
        Client::new()
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
        Client::new()
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

    let response_body = res.text().await.map_err(|err| {
        let error_msg = format!("Failed to read offchain lookup server response: ({err})");
        MetadataBuildError::FailedToBuild(error_msg)
    })?;
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

    // remove leading 0x which hex_decode doesn't like
    let hex_data = &json.data[2..];

    let metadata = hex_decode(hex_data).map_err(|err| {
        let msg = format!(
            "Failed to decode hex from offchain lookup server response: err: ({}), data: ({})",
            err, json.data
        );
        MetadataBuildError::FailedToBuild(msg)
    })?;
    Ok(Metadata::new(metadata))
}

fn create_ccip_url_regex() -> RegexSet {
    RegexSetBuilder::new([
        r#"^(https?:\/\/)localhost"#,
        r#"^(https?:\/\/)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"#,
        r#"localhost"#,
        r#"\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}"#,
        r#"([-a-zA-Z0-9:%._\+~#=]*)\.local"#,
        r#"([-a-zA-Z0-9:%._\+~#=]*)\.internal"#,
        r#"^(https?:\/\/)([-a-zA-Z0-9:%._\+~#=]*)\.local"#,
        r#"^(https?:\/\/)([-a-zA-Z0-9:%._\+~#=]*)\.internal"#,
    ])
    .case_insensitive(true)
    .build()
    .expect("Failed to create ccip regex")
}

#[cfg(test)]
mod test {
    use std::{
        str::FromStr,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
        vec,
    };

    use ethers::types::H160 as EthersH160;
    use futures::future::join_all;
    use hyperlane_core::{HyperlaneSignerError, Signature as HyperlaneSignature, SignedType, U256};
    use hyperlane_ethereum::Signers;

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

    #[test]
    fn test_ccip_regex_filter() {
        let set = create_ccip_url_regex();

        let urls = [
            "localhost",
            "localhost:80",
            "localhost:443",
            "localhost/abc/def",
            "0.0.0.0",
            "0.0.0.0:80",
            "0.0.0.0:443",
            "127.0.0.1",
            "127.0.0.1:80",
            "127.0.0.1:443",
            "http://localhost",
            "http://localhost:80",
            "http://localhost:443",
            "http://localhost/abc/def",
            "http://0.0.0.0",
            "http://0.0.0.0:80",
            "http://0.0.0.0:443",
            "http://0.0.0.0/abc/def",
            "http://127.0.0.1",
            "http://127.0.0.1:80",
            "http://127.0.0.1:443",
            "https://localhost",
            "https://localhost:80",
            "https://localhost:443",
            "https://0.0.0.0",
            "https://0.0.0.0:80",
            "https://0.0.0.0:443",
            "https://127.0.0.1",
            "https://127.0.0.1:80",
            "https://127.0.0.1:443",
            "abc.local",
            "abc.def.local",
            "abc.def.local/abc/def",
            "abc.def.ghi.local",
            "https://abc.local",
            "https://abc.def.local",
            "https://abc.def.local/abc/def",
            "abc.internal",
            "abc.def.internal",
            "abc.def.internal/abc/def",
            "abc.def.ghi.internal",
            "https://abc.internal",
            "https://abc.def.internal",
            "https://abc.def.internal/abc/def",
            "abc.def.cluster.local",
            "abc.cluster.local",
            "cluster.local",
            "abc3.c.def-ghi8.internal",
            "c.def-ghi8.internal",
            "google.internal",
            "https://hyperlane.xyz",
            "https://docs.hyperlane.xyz/",
            "http://docs.hyperlane.xyz/",
            "http://docs.hyperlane.xyz:443",
            "hyperlane.xyz",
            "docs.hyperlane.xyz/",
            "docs.hyperlane.xyz/abc/def",
        ];

        let filtered: Vec<_> = urls.into_iter().filter(|s| !set.is_match(s)).collect();
        let expected = [
            "https://hyperlane.xyz",
            "https://docs.hyperlane.xyz/",
            "http://docs.hyperlane.xyz/",
            "http://docs.hyperlane.xyz:443",
            "hyperlane.xyz",
            "docs.hyperlane.xyz/",
            "docs.hyperlane.xyz/abc/def",
        ];

        assert_eq!(filtered.len(), expected.len());
        for (actual, expected) in filtered.into_iter().zip(expected.into_iter()) {
            assert_eq!(actual, expected);
        }
    }
}
