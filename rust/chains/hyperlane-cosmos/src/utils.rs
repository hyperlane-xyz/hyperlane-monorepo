use std::num::NonZeroU64;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures::future;
use hyperlane_core::{ChainCommunicationError, ChainResult, Indexed, LogMeta};
use once_cell::sync::Lazy;
use tokio::task::JoinHandle;
use tracing::warn;

use crate::grpc::{WasmGrpcProvider, WasmProvider};

/// The event attribute key for the contract address.
pub(crate) const CONTRACT_ADDRESS_ATTRIBUTE_KEY: &str = "_contract_address";
/// Base64 encoded version of the contract address attribute key, i.e.
pub(crate) static CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64: Lazy<String> =
    Lazy::new(|| BASE64.encode(CONTRACT_ADDRESS_ATTRIBUTE_KEY));

/// Given a lag, returns the block height at the moment.
/// If the lag is None, a block height of None is given, indicating that the
/// tip directly can be used.
pub(crate) async fn get_block_height_for_lag(
    provider: &WasmGrpcProvider,
    lag: Option<NonZeroU64>,
) -> ChainResult<Option<u64>> {
    let block_height = match lag {
        Some(lag) => {
            let tip = provider.latest_block_height().await?;
            let block_height = tip - lag.get();
            Some(block_height)
        }
        None => None,
    };

    Ok(block_height)
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
