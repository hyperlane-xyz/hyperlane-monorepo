use std::fmt::Debug;
use std::num::NonZeroU64;
use std::ops::RangeInclusive;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::future;
use once_cell::sync::Lazy;
use tendermint::abci::EventAttribute;
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tokio::task::JoinHandle;
use tracing::warn;

use hyperlane_core::{ChainCommunicationError, ChainResult, Indexed, LogMeta, ReorgPeriod, H256};

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use crate::rpc::{CosmosWasmRpcProvider, ParsedEvent, WasmRpcProvider};

type FutureChainResults<T> = Vec<JoinHandle<(ChainResult<Vec<(T, LogMeta)>>, u32)>>;

/// The event attribute key for the contract address.
pub(crate) const CONTRACT_ADDRESS_ATTRIBUTE_KEY: &str = "_contract_address";
/// Base64 encoded version of the contract address attribute key, i.e.
pub(crate) static CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(CONTRACT_ADDRESS_ATTRIBUTE_KEY));

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
    let tendermint_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
        .expect("transaction hash should be of correct size");

    provider
        .get_logs_in_tx(tendermint_hash, parser, label)
        .await
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

#[cfg(test)]
/// Helper function to create a Vec<EventAttribute> from a JSON string -
/// crate::payloads::general::EventAttribute has a Deserialize impl while
/// cosmrs::tendermint::abci::EventAttribute does not.
pub(crate) fn event_attributes_from_str(
    attrs_str: &str,
) -> Vec<cosmrs::tendermint::abci::EventAttribute> {
    serde_json::from_str::<Vec<crate::payloads::general::EventAttribute>>(attrs_str)
        .unwrap()
        .into_iter()
        .map(|attr| attr.into())
        .collect()
}
