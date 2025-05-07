// the evm provider-building logic returns a box. `EvmProviderForSubmitter` is only implemented for the underlying type rather than the boxed type.
// implementing the trait for the boxed type would require a lot of boilerplate code.
#![allow(clippy::borrowed_box)]

use ethers::{providers::ProviderError, types::BlockNumber};
use hyperlane_core::{ChainCommunicationError, ChainResult, HyperlaneDomain, U256};
use hyperlane_ethereum::{EvmProviderForSubmitter, TransactionOverrides};
use tracing::{debug, warn};

use crate::{chain_tx_adapter::EthereumTxPrecursor, transaction::Transaction, SubmitterError};

/// An amount of gas to add to the estimated gas limit
pub const GAS_LIMIT_BUFFER: u32 = 75_000;

// A multiplier to apply to the estimated gas limit, i.e. 10%.
pub const DEFAULT_GAS_LIMIT_MULTIPLIER_NUMERATOR: u32 = 11;
pub const DEFAULT_GAS_LIMIT_MULTIPLIER_DENOMINATOR: u32 = 10;

pub async fn estimate_tx(
    provider: &Box<dyn EvmProviderForSubmitter>,
    tx_precursor: &mut EthereumTxPrecursor,
    transaction_overrides: &TransactionOverrides,
    domain: &HyperlaneDomain,
    with_gas_limit_overrides: bool,
) -> std::result::Result<(), SubmitterError> {
    // either use the pre-estimated gas limit or estimate it
    let mut estimated_gas_limit: U256 = match tx_precursor.tx.gas() {
        Some(&estimate) => estimate.into(),
        None => {
            provider
                .estimate_gas_limit(&tx_precursor.tx, &tx_precursor.function)
                .await?
        }
    };

    if with_gas_limit_overrides {
        estimated_gas_limit = apply_gas_estimate_buffer(estimated_gas_limit, domain)?;
        if let Some(gas_limit) = transaction_overrides.gas_limit {
            estimated_gas_limit = estimated_gas_limit.max(gas_limit)
        }
    }
    let gas_limit = estimated_gas_limit;

    // Cap the gas limit to the block gas limit
    let latest_block = provider
        .get_block(BlockNumber::Latest)
        .await
        .map_err(ChainCommunicationError::from_other)?
        .ok_or_else(|| eyre::eyre!("Latest block not found"))?;

    let block_gas_limit: U256 = latest_block.gas_limit.into();
    let gas_limit = if gas_limit > block_gas_limit {
        warn!(
                ?gas_limit,
                ?block_gas_limit,
                "Gas limit for transaction is higher than the block gas limit. Capping it to the block gas limit."
            );
        block_gas_limit
    } else {
        gas_limit
    };
    debug!(?estimated_gas_limit, gas_override=?transaction_overrides.gas_limit, used_gas_limit=?gas_limit, "Gas limit set for transaction");

    tx_precursor.tx.set_gas(gas_limit);
    Ok(())
}

pub fn apply_gas_estimate_buffer(gas: U256, domain: &HyperlaneDomain) -> ChainResult<U256> {
    // Arbitrum Nitro chains use 2d fees and are especially prone to costs increasing
    // by the time the transaction lands on chain, requiring a higher gas limit.
    // In this case, we apply a multiplier to the gas estimate.
    let gas = if domain.is_arbitrum_nitro() {
        gas.saturating_mul(DEFAULT_GAS_LIMIT_MULTIPLIER_NUMERATOR.into())
            .checked_div(DEFAULT_GAS_LIMIT_MULTIPLIER_DENOMINATOR.into())
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Gas estimate buffer divide by zero")
            })?
    } else {
        gas
    };

    // Always add a flat buffer
    Ok(gas.saturating_add(GAS_LIMIT_BUFFER.into()))
}
