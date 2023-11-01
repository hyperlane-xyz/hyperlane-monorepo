use std::num::NonZeroU64;

use crate::grpc::{WasmGrpcProvider, WasmProvider};
use hyperlane_core::ChainResult;

/// The event attribute key for the contract address.
pub(crate) const CONTRACT_ADDRESS_ATTRIBUTE_KEY: &str = "_contract_address";
/// Base64 encoded version of the contract address attribute key, i.e.
/// echo -n _contract_address | base64
pub(crate) const CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64: &str = "X2NvbnRyYWN0X2FkZHJlc3M=";

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

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine};

    #[test]
    fn test_contract_address_base64() {
        assert_eq!(
            super::CONTRACT_ADDRESS_ATTRIBUTE_KEY_BASE64,
            BASE64.encode(super::CONTRACT_ADDRESS_ATTRIBUTE_KEY)
        );
    }
}
