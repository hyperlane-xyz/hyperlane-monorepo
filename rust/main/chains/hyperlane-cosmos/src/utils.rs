<<<<<<< HEAD
use std::fmt::Debug;
use std::num::NonZeroU64;
use std::ops::RangeInclusive;

use base64::prelude::BASE64_STANDARD_NO_PAD;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use cometbft::abci::EventAttribute;
use cometbft::hash::Algorithm;
use cometbft::Hash;
use cosmrs::crypto::PublicKey;
use futures::future;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tracing::warn;

use hyperlane_core::{ChainCommunicationError, ChainResult, Indexed, LogMeta, ReorgPeriod, H256};

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use crate::rpc::{CosmosWasmRpcProvider, ParsedEvent, WasmRpcProvider};
use crate::HyperlaneCosmosError;

type FutureChainResults<T> = Vec<JoinHandle<(ChainResult<Vec<(T, LogMeta)>>, u32)>>;
=======
use base64::{
    engine::general_purpose::STANDARD as BASE64, prelude::BASE64_STANDARD_NO_PAD, Engine,
};
use once_cell::sync::Lazy;
>>>>>>> main

/// The event attribute key for the contract address.
pub(crate) const CONTRACT_ADDRESS_ATTRIBUTE_KEY: &str = "_contract_address";
/// Base64 encoded version of the contract address attribute key, i.e.
pub(crate) static CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(CONTRACT_ADDRESS_ATTRIBUTE_KEY));

<<<<<<< HEAD
/// Given a `reorg_period`, returns the block height at the moment.
/// If the `reorg_period` is None, a block height of None is given,
/// indicating that the tip directly can be used.
pub(crate) async fn get_block_height_for_reorg_period(
    provider: &WasmGrpcProvider,
    reorg_period: &ReorgPeriod,
) -> ChainResult<u64> {
    let period = match reorg_period {
        ReorgPeriod::Blocks(blocks) => blocks.get() as u64,
        ReorgPeriod::None => 0,
        ReorgPeriod::Tag(_) => {
            return Err(ChainCommunicationError::InvalidReorgPeriod(
                reorg_period.clone(),
            ))
        }
    };

    let tip = provider.latest_block_height().await?;
    let block_height = tip - period;
    Ok(block_height)
}

pub(crate) fn parse_logs_in_range<T: PartialEq + Send + Sync + Debug + 'static>(
    range: RangeInclusive<u32>,
    provider: Box<CosmosWasmRpcProvider>,
    parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    label: &'static str,
) -> FutureChainResults<T> {
    range
        .map(|block_number| {
            let provider = provider.clone();
            tokio::spawn(async move {
                let logs = provider
                    .get_logs_in_block(block_number, parser, label)
                    .await;
                (logs, block_number)
            })
        })
        .collect()
}

pub(crate) async fn parse_logs_in_tx<T: PartialEq + Send + Sync + Debug + 'static>(
    hash: &H256,
    provider: Box<CosmosWasmRpcProvider>,
    parser: for<'a> fn(&'a Vec<EventAttribute>) -> ChainResult<ParsedEvent<T>>,
    label: &'static str,
) -> ChainResult<Vec<(T, LogMeta)>> {
    let sha_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
        .expect("transaction hash should be of correct size");

    provider.get_logs_in_tx(sha_hash, parser, label).await
}

#[allow(clippy::type_complexity)]
pub(crate) async fn execute_and_parse_log_futures<T: Into<Indexed<T>>>(
    logs_futures: Vec<JoinHandle<(Result<Vec<(T, LogMeta)>, ChainCommunicationError>, u32)>>,
) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
    // TODO: this can be refactored when we rework indexing, to be part of the block-by-block indexing
    let result = future::join_all(logs_futures)
        .await
        .into_iter()
        .flatten()
        .map(|(logs, block_number)| {
            if let Err(err) = &logs {
                warn!(?err, ?block_number, "Failed to fetch logs for block");
            }
            logs
        })
        // Propagate errors from any of the queries. This will cause the entire range to be retried,
        // including successful ones, but we don't have a way to handle partial failures in a range for now.
        // This is also why cosmos indexing should be run with small chunks (currently set to 5).
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .flatten()
        .map(|(log, meta)| (log.into(), meta))
        .collect();
    Ok(result)
}

=======
>>>>>>> main
#[cfg(test)]
/// Helper function to create a Vec<EventAttribute> from a JSON string -
/// crate::payloads::general::EventAttribute has a Deserialize impl while
/// cosmrs::tendermint::abci::EventAttribute does not.
pub(crate) fn event_attributes_from_str(attrs_str: &str) -> Vec<cometbft::abci::EventAttribute> {
<<<<<<< HEAD
    serde_json::from_str::<Vec<crate::payloads::general::EventAttribute>>(attrs_str)
=======
    serde_json::from_str::<Vec<crate::cw::payloads::general::EventAttribute>>(attrs_str)
>>>>>>> main
        .unwrap()
        .into_iter()
        .map(|attr| attr.into())
        .collect()
}

<<<<<<< HEAD
=======
use cometbft_rpc::endpoint::broadcast::tx_commit::Response;
use cosmrs::{crypto::PublicKey, proto, tx::SignerPublicKey, Any};
use crypto::decompress_public_key;
use serde::{Deserialize, Serialize};
use tracing::warn;

use hyperlane_core::{AccountAddressType, ChainResult, FixedPointNumber, TxOutcome, H256};

const INJECTIVE_PUBLIC_KEY_TYPE_URL: &str = "/injective.crypto.v1beta1.ethsecp256k1.PubKey";

use crate::HyperlaneCosmosError;

>>>>>>> main
#[derive(Clone, Debug, Deserialize, Serialize)]
struct CosmosKeyJsonFormat {
    #[serde(rename = "@type")]
    pub key_type: &'static str,
    pub key: String,
}

<<<<<<< HEAD
=======
pub fn normalize_public_key(
    signer_public_key: SignerPublicKey,
) -> ChainResult<(SignerPublicKey, AccountAddressType)> {
    let public_key_and_account_address_type = match signer_public_key {
        SignerPublicKey::Single(pk) => (SignerPublicKey::from(pk), AccountAddressType::Bitcoin),
        SignerPublicKey::LegacyAminoMultisig(pk) => {
            (SignerPublicKey::from(pk), AccountAddressType::Bitcoin)
        }
        SignerPublicKey::Any(pk) => {
            if pk.type_url != PublicKey::ED25519_TYPE_URL
                && pk.type_url != PublicKey::SECP256K1_TYPE_URL
                && pk.type_url != INJECTIVE_PUBLIC_KEY_TYPE_URL
            {
                let msg = format!(
                    "can only normalize public keys with a known TYPE_URL: {}, {}, {}",
                    PublicKey::ED25519_TYPE_URL,
                    PublicKey::SECP256K1_TYPE_URL,
                    INJECTIVE_PUBLIC_KEY_TYPE_URL
                );
                warn!(pk.type_url, msg);
                Err(HyperlaneCosmosError::PublicKeyError(msg.to_owned()))?
            }

            let (pub_key, account_address_type) = if pk.type_url == INJECTIVE_PUBLIC_KEY_TYPE_URL {
                let any = Any {
                    type_url: PublicKey::SECP256K1_TYPE_URL.to_owned(),
                    value: pk.value,
                };

                let proto: proto::cosmos::crypto::secp256k1::PubKey =
                    any.to_msg().map_err(Into::<HyperlaneCosmosError>::into)?;

                let decompressed = decompress_public_key(&proto.key)
                    .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;

                let cometbft_key = cometbft::PublicKey::from_raw_secp256k1(&decompressed)
                    .ok_or_else(|| {
                        HyperlaneCosmosError::PublicKeyError(
                            "cannot create cometbft public key".to_owned(),
                        )
                    })?;

                let cosm_key = cometbft_pubkey_to_cosmrs_pubkey(&cometbft_key)?;
                (cosm_key, AccountAddressType::Ethereum)
            } else {
                (PublicKey::try_from(pk)?, AccountAddressType::Bitcoin)
            };

            (SignerPublicKey::Single(pub_key), account_address_type)
        }
    };

    Ok(public_key_and_account_address_type)
}

>>>>>>> main
pub fn cometbft_pubkey_to_cosmrs_pubkey(
    cometbft_key: &cometbft::PublicKey,
) -> ChainResult<cosmrs::crypto::PublicKey> {
    let cometbft_key_json = serde_json::to_string(&cometbft_key)
        .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;

    let cosmos_key_json = match cometbft_key {
        cometbft::PublicKey::Ed25519(key) => CosmosKeyJsonFormat {
            key_type: cosmrs::crypto::PublicKey::ED25519_TYPE_URL,
            key: BASE64_STANDARD_NO_PAD.encode(key.as_bytes()),
        },
        cometbft::PublicKey::Secp256k1(key) => CosmosKeyJsonFormat {
            key_type: cosmrs::crypto::PublicKey::SECP256K1_TYPE_URL,
            key: BASE64_STANDARD_NO_PAD.encode(key.to_sec1_bytes()),
        },
        // not sure why it requires me to have this extra arm. But
        // we should never reach this
        _ => {
            return Err(HyperlaneCosmosError::PublicKeyError("Invalid key".into()).into());
        }
    };

    let json_val = serde_json::to_string(&cosmos_key_json)
        .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;
    let cosm_key = PublicKey::from_json(&json_val)
        .map_err(|e| HyperlaneCosmosError::PublicKeyError(e.to_string()))?;
    Ok(cosm_key)
}

<<<<<<< HEAD
#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn test_cometbft_pubkey_to_cosmrs_pubkey_ed25519() {
        let key_bytes =
            hex::decode("F09E4D1CA00583669C8FB10B539DE25FB75CAD5A7C72569C2C3E08D05EB0DC71")
                .expect("Failed to decode hex");
        let key =
            cometbft::PublicKey::from_raw_ed25519(&key_bytes).expect("Failed to parse ed25519 key");

        let cosmos_key = cometbft_pubkey_to_cosmrs_pubkey(&key).expect("Failed to parse key");

        println!("{:?}", cosmos_key);
    }

    #[test]
    fn test_cometbft_pubkey_to_cosmrs_pubkey_secp256k1() {
        let key_bytes = hex::decode("046da0967f2293b5ce9982ed7b0114cc36e4bb608d6e4d00140b9ee2a491af967448050dab0ae25263668e285acad1e91ea53b871b65f31aafc80ae6fb54e48567")
            .expect("Failed to decode hex");
        let key = cometbft::PublicKey::from_raw_secp256k1(&key_bytes)
            .expect("Failed to parse secp256k1 key");

        let cosmos_key = cometbft_pubkey_to_cosmrs_pubkey(&key).expect("Failed to parse key");

        println!("{:?}", cosmos_key);
=======
pub(crate) fn tx_response_to_outcome(response: Response, gas_price: FixedPointNumber) -> TxOutcome {
    TxOutcome {
        transaction_id: H256::from_slice(response.hash.as_bytes()).into(),
        executed: response.check_tx.code.is_ok() && response.tx_result.code.is_ok(),
        gas_used: response.tx_result.gas_used.into(),
        gas_price,
>>>>>>> main
    }
}
