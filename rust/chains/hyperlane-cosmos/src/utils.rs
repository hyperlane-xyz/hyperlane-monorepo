use std::num::NonZeroU64;

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use hyperlane_core::ChainResult;

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
