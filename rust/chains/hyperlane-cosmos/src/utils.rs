use std::num::NonZeroU64;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hyperlane_core::ChainResult;
use once_cell::sync::Lazy;

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
