use std::{sync::OnceLock, time::Duration};

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Result;
use reqwest::Client;
use serde::Deserialize;
use tracing::{instrument, warn};

use hyperlane_core::{
    h512_to_bytes, utils::bytes_to_hex, HyperlaneDomainType, HyperlaneMessage, Metadata, H256,
};

use super::{
    base::{MessageMetadataBuildParams, MetadataBuildError},
    MessageMetadataBuilder, MetadataBuilder,
};

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAINNET_IRIS_BASE_URL: &str = "https://iris-api.circle.com";
const TESTNET_IRIS_BASE_URL: &str = "https://iris-api-sandbox.circle.com";
const MAX_PENDING_RETRIES: u32 = 10;
const PENDING_RETRY_INTERVAL: Duration = Duration::from_secs(2);

/// Hyperlane chain name -> Circle CCTP v2 domain ID, for chains this
/// integration has confirmed support for (developers.circle.com/cctp/
/// cctp-supported-blockchains). Testnets share their mainnet's Circle
/// domain. Extend as new CCTP v2 routes are added.
fn circle_domain_for_chain(chain_name: &str) -> Option<u32> {
    match chain_name {
        "ethereum" | "sepolia" => Some(0),
        "arbitrum" | "arbitrumsepolia" => Some(3),
        "solanamainnet" | "solanadevnet" => Some(5),
        _ => None,
    }
}

/// Builds metadata for the Sealevel `hyperlane-sealevel-token-cctp` ISM
/// (`ModuleType::CctpV2`) — fetches the CCTP v2 message + Circle attestation
/// for the message's origin dispatch transaction from Circle's Iris API,
/// and Borsh-encodes them into the `CctpV2Metadata { message, attestation }`
/// shape the ISM's `Verify()` expects.
///
/// Unlike EVM's `TokenBridgeCctpV2` (which reports `ModuleType::CcipRead`
/// and is resolved via an on-chain revert/URL/HTTP-fetch cycle), this ISM's
/// `Verify()` takes the metadata directly — there's no on-chain trigger on
/// Solana, so the relayer must know to fetch it itself.
#[derive(Debug, Clone, new, Deref)]
pub struct CctpV2MetadataBuilder {
    base: MessageMetadataBuilder,
}

#[derive(Debug, Deserialize)]
struct CircleV2MessagesResponse {
    messages: Vec<CircleV2Message>,
}

#[derive(Debug, Deserialize)]
struct CircleV2Message {
    message: Option<String>,
    attestation: Option<String>,
    status: String,
}

#[derive(borsh::BorshSerialize)]
struct CctpV2Metadata {
    message: Vec<u8>,
    attestation: Vec<u8>,
}

/// Process-wide client so requests to Circle's Iris API reuse pooled
/// connections. Circle's hosts are fixed, hardcoded constants (not
/// user/config-supplied), so this doesn't need the SSRF-hardened
/// custom-DNS-resolver treatment `ccip_read`'s client uses for
/// operator-configured CCIP-read gateway URLs.
static CCTP_V2_HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();

fn cctp_v2_http_client() -> Result<&'static Client, Box<MetadataBuildError>> {
    match CCTP_V2_HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
            .build()
            .map_err(|err| err.to_string())
    }) {
        Ok(client) => Ok(client),
        Err(err) => Err(Box::new(MetadataBuildError::FailedToBuild(format!(
            "Failed to build CCTP v2 HTTP client: {err}"
        )))),
    }
}

fn hex_decode(s: &str) -> Result<Vec<u8>, Box<MetadataBuildError>> {
    let trimmed = s.strip_prefix("0x").unwrap_or(s);
    hex::decode(trimmed).map_err(|err| {
        Box::new(MetadataBuildError::FailedToBuild(format!(
            "Invalid hex in CCTP v2 response: {err}"
        )))
    })
}

#[async_trait]
impl MetadataBuilder for CctpV2MetadataBuilder {
    #[instrument(err, skip(self, message, _params))]
    async fn build(
        &self,
        _ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let origin = self.base.base_builder().origin_domain();
        let circle_domain = circle_domain_for_chain(origin.name()).ok_or_else(|| {
            MetadataBuildError::FailedToBuild(format!(
                "No known Circle CCTP v2 domain for origin chain {}",
                origin.name()
            ))
        })?;

        let tx_hash = self
            .base
            .base_builder()
            .retrieve_origin_tx_hash_by_message_id(message.id())
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?
            .ok_or(MetadataBuildError::CouldNotFetch)?;
        let tx_hash_hex = bytes_to_hex(&h512_to_bytes(&tx_hash));

        let base_url = if matches!(
            origin.domain_type(),
            HyperlaneDomainType::Testnet | HyperlaneDomainType::LocalTestChain
        ) {
            TESTNET_IRIS_BASE_URL
        } else {
            MAINNET_IRIS_BASE_URL
        };
        let url = format!("{base_url}/v2/messages/{circle_domain}?transactionHash={tx_hash_hex}");

        let client = cctp_v2_http_client().map_err(|err| *err)?;

        for attempt in 0..MAX_PENDING_RETRIES {
            let response = client.get(&url).send().await.map_err(|err| {
                MetadataBuildError::FailedToBuild(format!("CCTP v2 Iris request failed: {err}"))
            })?;

            if !response.status().is_success() {
                return Err(MetadataBuildError::FailedToBuild(format!(
                    "CCTP v2 Iris request returned status {}",
                    response.status()
                )));
            }

            let parsed: CircleV2MessagesResponse = response.json().await.map_err(|err| {
                MetadataBuildError::FailedToBuild(format!(
                    "Failed to parse CCTP v2 Iris response: {err}"
                ))
            })?;

            // An empty array means Iris hasn't indexed the burn tx yet —
            // treat it the same as an explicit "pending" status rather than
            // failing hard, since this is routinely transient right after
            // the burn (indexing lag), not a permanent condition.
            let Some(entry) = parsed.messages.first() else {
                warn!(attempt, "CCTP v2 message not yet indexed by Iris, retrying");
                tokio::time::sleep(PENDING_RETRY_INTERVAL).await;
                continue;
            };

            if entry.status != "complete" {
                warn!(
                    attempt,
                    status = %entry.status,
                    "CCTP v2 attestation not yet complete, retrying"
                );
                tokio::time::sleep(PENDING_RETRY_INTERVAL).await;
                continue;
            }

            let message_hex = entry
                .message
                .as_deref()
                .ok_or(MetadataBuildError::CouldNotFetch)?;
            let attestation_hex = entry
                .attestation
                .as_deref()
                .ok_or(MetadataBuildError::CouldNotFetch)?;

            let encoded = borsh::to_vec(&CctpV2Metadata {
                message: hex_decode(message_hex).map_err(|err| *err)?,
                attestation: hex_decode(attestation_hex).map_err(|err| *err)?,
            })
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

            return Ok(Metadata::new(encoded));
        }

        Err(MetadataBuildError::CouldNotFetch)
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_circle_domain_for_chain() {
        assert_eq!(circle_domain_for_chain("sepolia"), Some(0));
        assert_eq!(circle_domain_for_chain("ethereum"), Some(0));
        assert_eq!(circle_domain_for_chain("arbitrumsepolia"), Some(3));
        assert_eq!(circle_domain_for_chain("solanadevnet"), Some(5));
        assert_eq!(circle_domain_for_chain("unknownchain"), None);
    }

    #[test]
    fn test_hex_decode_strips_0x_prefix() {
        assert_eq!(hex_decode("0x0102").unwrap(), vec![0x01, 0x02]);
        assert_eq!(hex_decode("0102").unwrap(), vec![0x01, 0x02]);
        assert!(hex_decode("zz").is_err());
    }
}
