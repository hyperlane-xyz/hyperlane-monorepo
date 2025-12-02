use std::sync::Arc;

use ethers::{
    providers::ProviderError,
    types::{BlockNumber, U256 as EthersU256},
};
use hyperlane_core::{ChainCommunicationError, ChainResult, HyperlaneDomain, U256};
use hyperlane_ethereum::{EvmProviderForLander, TransactionOverrides};
use tracing::{debug, warn};

use crate::{adapter::EthereumTxPrecursor, transaction::Transaction, LanderError};

/// An amount of gas to add to the estimated gas limit
pub const GAS_LIMIT_BUFFER: u32 = 75_000;

// A multiplier to apply to the estimated gas limit, i.e. 10%.
pub const DEFAULT_GAS_LIMIT_MULTIPLIER_NUMERATOR: u32 = 11;
pub const DEFAULT_GAS_LIMIT_MULTIPLIER_DENOMINATOR: u32 = 10;

pub async fn estimate_gas_limit(
    provider: Arc<dyn EvmProviderForLander>,
    tx_precursor: &mut EthereumTxPrecursor,
    transaction_overrides: &TransactionOverrides,
    domain: &HyperlaneDomain,
    with_gas_limit_overrides: bool,
) -> Result<(), LanderError> {
    let mut estimated_gas_limit: U256 = provider
        .estimate_gas_limit(&tx_precursor.tx, &tx_precursor.function)
        .await?;

    if with_gas_limit_overrides {
        estimated_gas_limit = apply_gas_estimate_buffer(estimated_gas_limit, domain)?;
        if let Some(gas_limit) = transaction_overrides.gas_limit {
            estimated_gas_limit = estimated_gas_limit.max(gas_limit)
        }
    }

    estimated_gas_limit = apply_gas_limit_cap(transaction_overrides, estimated_gas_limit);
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

pub fn apply_gas_limit_cap(transaction_overrides: &TransactionOverrides, gas_limit: U256) -> U256 {
    if let Some(gas_limit_cap) = transaction_overrides.gas_limit_cap {
        if gas_limit > gas_limit_cap {
            warn!(
                ?gas_limit,
                ?gas_limit_cap,
                "Gas limit for transaction is higher than the gas limit cap. Capping it to the gas limit cap."
            );
            return gas_limit_cap;
        }
    }
    gas_limit
}
// Used for testing
#[cfg(test)]
pub mod tests {
    use ethers::{
        abi::Function,
        types::{transaction::eip2718::TypedTransaction, Block, Eip1559TransactionRequest},
    };

    use crate::adapter::chains::ethereum::tests::MockEvmProvider;

    use super::*;

    pub fn apply_estimate_buffer_to_ethers(
        gas: EthersU256,
        domain: &HyperlaneDomain,
    ) -> ChainResult<EthersU256> {
        apply_gas_estimate_buffer(gas.into(), domain).map(Into::into)
    }

    #[tokio::test]
    async fn test_gas_limit_cap_applies() {
        #[allow(deprecated)]
        let mut tx_precursor = EthereumTxPrecursor {
            tx: TypedTransaction::Eip1559(Eip1559TransactionRequest::default()),
            function: Function {
                name: "test".into(),
                inputs: Vec::new(),
                outputs: Vec::new(),
                constant: None,
                state_mutability: ethers::abi::StateMutability::Payable,
            },
        };
        let mut provider = MockEvmProvider::new();

        provider
            .expect_estimate_gas_limit()
            .returning(|_, _| Ok(U256::from(10_000)));
        provider.expect_get_block().returning(|_| {
            Ok(Some(Block {
                gas_limit: EthersU256::from(100_000),
                ..Default::default()
            }))
        });

        let transaction_overrides = TransactionOverrides {
            gas_limit_cap: Some(U256::from(100)),
            ..Default::default()
        };
        let domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Ethereum);
        let with_gas_limit_overrides = false;

        estimate_gas_limit(
            Arc::new(provider),
            &mut tx_precursor,
            &transaction_overrides,
            &domain,
            with_gas_limit_overrides,
        )
        .await
        .expect("Failed to estimate gas limit");

        let expected_gas = EthersU256::from(100);
        let expected = Some(&expected_gas);
        assert_eq!(tx_precursor.tx.gas(), expected);
    }

    #[tokio::test]
    async fn test_gas_limit_cap_applies_with_gas_limit_override() {
        #[allow(deprecated)]
        let mut tx_precursor = EthereumTxPrecursor {
            tx: TypedTransaction::Eip1559(Eip1559TransactionRequest::default()),
            function: Function {
                name: "test".into(),
                inputs: Vec::new(),
                outputs: Vec::new(),
                constant: None,
                state_mutability: ethers::abi::StateMutability::Payable,
            },
        };
        let mut provider = MockEvmProvider::new();

        provider
            .expect_estimate_gas_limit()
            .returning(|_, _| Ok(U256::from(10_000)));
        provider.expect_get_block().returning(|_| {
            Ok(Some(Block {
                gas_limit: EthersU256::from(100_000),
                ..Default::default()
            }))
        });

        let transaction_overrides = TransactionOverrides {
            gas_limit_cap: Some(U256::from(100)),
            ..Default::default()
        };
        let domain = HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Ethereum);
        let with_gas_limit_overrides = true;

        estimate_gas_limit(
            Arc::new(provider),
            &mut tx_precursor,
            &transaction_overrides,
            &domain,
            with_gas_limit_overrides,
        )
        .await
        .expect("Failed to estimate gas limit");

        let expected_gas = EthersU256::from(100);
        let expected = Some(&expected_gas);
        assert_eq!(tx_precursor.tx.gas(), expected);
    }
}
