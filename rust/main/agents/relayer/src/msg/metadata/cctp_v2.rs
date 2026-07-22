use std::{sync::OnceLock, time::Duration};

use async_trait::async_trait;
use derive_more::Deref;
use derive_new::new;
use eyre::Result;
use reqwest::Client;
use serde::Deserialize;
use tracing::{info, instrument, warn};

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
/// then stages them directly into a Solana PDA via `SealevelCctpStager`
/// rather than returning them as this ISM's `Metadata` — that payload plus
/// the raw Hyperlane message plus the ~23 Circle CPI accounts `Verify()`
/// needs would together exceed Solana's transaction size limit. The
/// `Metadata` returned here is always empty; `Verify()` reads the staged
/// PDA instead (keyed by the Hyperlane message id).
///
/// Unlike EVM's `TokenBridgeCctpV2` (which reports `ModuleType::CcipRead`
/// and is resolved via an on-chain revert/URL/HTTP-fetch cycle), this ISM's
/// `Verify()` takes the metadata directly — there's no on-chain trigger on
/// Solana, so the relayer must know to fetch (and now, stage) it itself.
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
        ism_address: H256,
        message: &HyperlaneMessage,
        _params: MessageMetadataBuildParams,
    ) -> Result<Metadata, MetadataBuildError> {
        let origin = self.base.base_builder().origin_domain();
        info!(
            message_id = ?message.id(),
            ism_address = ?ism_address,
            origin = origin.name(),
            destination = self.base.base_builder().destination_domain().name(),
            "[cctp] Building CCTP v2 metadata"
        );
        let circle_domain = circle_domain_for_chain(origin.name()).ok_or_else(|| {
            MetadataBuildError::FailedToBuild(format!(
                "No known Circle CCTP v2 domain for origin chain {}",
                origin.name()
            ))
        })?;
        info!(
            message_id = ?message.id(),
            origin = origin.name(),
            circle_domain,
            "[cctp] Resolved Circle CCTP v2 domain for origin chain"
        );

        let tx_hash = self
            .base
            .base_builder()
            .retrieve_origin_tx_hash_by_message_id(message.id())
            .await
            .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
        let tx_hash = match tx_hash {
            Some(tx_hash) => tx_hash,
            None => {
                info!(
                    message_id = ?message.id(),
                    "[cctp] No origin dispatch tx hash found in DB yet for CCTP v2 message; \
                     will retry once indexed"
                );
                return Err(MetadataBuildError::CouldNotFetch);
            }
        };
        let tx_hash_hex = bytes_to_hex(&h512_to_bytes(&tx_hash));
        info!(
            message_id = ?message.id(),
            tx_hash = %tx_hash_hex,
            "[cctp] Retrieved origin dispatch tx hash for CCTP v2 message"
        );

        let base_url = if matches!(
            origin.domain_type(),
            HyperlaneDomainType::Testnet | HyperlaneDomainType::LocalTestChain
        ) {
            TESTNET_IRIS_BASE_URL
        } else {
            MAINNET_IRIS_BASE_URL
        };
        let url = format!("{base_url}/v2/messages/{circle_domain}?transactionHash={tx_hash_hex}");
        info!(
            message_id = ?message.id(),
            url = %url,
            "[cctp] Querying Circle Iris API for CCTP v2 attestation"
        );

        let client = cctp_v2_http_client().map_err(|err| *err)?;

        for attempt in 0..MAX_PENDING_RETRIES {
            let response = client.get(&url).send().await.map_err(|err| {
                MetadataBuildError::FailedToBuild(format!("CCTP v2 Iris request failed: {err}"))
            })?;

            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                info!(
                    message_id = ?message.id(),
                    %status,
                    body = %body,
                    "[cctp] CCTP v2 Iris request returned a non-success status"
                );
                return Err(MetadataBuildError::FailedToBuild(format!(
                    "CCTP v2 Iris request returned status {status}"
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
                warn!(
                    message_id = ?message.id(),
                    attempt,
                    "[cctp] CCTP v2 message not yet indexed by Iris, retrying"
                );
                tokio::time::sleep(PENDING_RETRY_INTERVAL).await;
                continue;
            };

            if entry.status != "complete" {
                warn!(
                    message_id = ?message.id(),
                    attempt,
                    status = %entry.status,
                    "[cctp] CCTP v2 attestation not yet complete, retrying"
                );
                tokio::time::sleep(PENDING_RETRY_INTERVAL).await;
                continue;
            }

            let message_hex = entry.message.as_deref().ok_or_else(|| {
                info!(
                    message_id = ?message.id(),
                    "[cctp] CCTP v2 Iris entry reported status=complete but is missing the `message` field"
                );
                MetadataBuildError::CouldNotFetch
            })?;
            let attestation_hex = entry.attestation.as_deref().ok_or_else(|| {
                info!(
                    message_id = ?message.id(),
                    "[cctp] CCTP v2 Iris entry reported status=complete but is missing the `attestation` field"
                );
                MetadataBuildError::CouldNotFetch
            })?;

            let cctp_message = hex_decode(message_hex).map_err(|err| *err)?;
            let attestation = hex_decode(attestation_hex).map_err(|err| *err)?;

            // Stage {cctp_message, attestation} into a PDA now, rather than
            // returning them as this ISM's metadata — the combination of
            // that payload, the raw Hyperlane message, and the ~23 Circle
            // CPI accounts `Verify()` needs together exceed Solana's
            // transaction size limit. `Verify()` reads the staged PDA
            // instead; `metadata` is unused for this ISM (see
            // `hyperlane-sealevel-token-cctp::ism` module docs).
            let stager = self
                .base
                .base_builder()
                .build_sealevel_cctp_stager(ism_address)
                .await
                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;
            stager
                .stage_verify_metadata(message.id(), cctp_message, attestation)
                .await
                .map_err(|err| MetadataBuildError::FailedToBuild(err.to_string()))?;

            info!(
                message_id = ?message.id(),
                "[cctp] Successfully staged CCTP v2 metadata from Circle attestation"
            );
            return Ok(Metadata::new(Vec::new()));
        }

        info!(
            message_id = ?message.id(),
            attempts = MAX_PENDING_RETRIES,
            "[cctp] Exhausted retries waiting for CCTP v2 attestation to complete"
        );
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
