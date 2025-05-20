// the evm provider-building logic returns a box. `EvmProviderForSubmitter` is only implemented for the underlying type rather than the boxed type.
// implementing the trait for the boxed type would require a lot of boilerplate code.
#![allow(clippy::borrowed_box)]

use std::{str::FromStr, sync::Arc};

use ethers::{
    abi::Detokenize,
    contract::builders::ContractCall,
    providers::{Middleware, ProviderError},
    types::{
        transaction::eip2718::TypedTransaction, Block, Eip1559TransactionRequest, H160,
        H256 as TxHash,
    },
};
use futures_util::try_join;
use hyperlane_core::{ChainCommunicationError, ChainResult, HyperlaneDomain, U256};
use hyperlane_ethereum::{
    EvmProviderForSubmitter, TransactionOverrides, ZksyncEstimateFeeResponse,
};
use tracing::{debug, warn};

use ethers_core::{
    types::{BlockNumber, U256 as EthersU256},
    utils::{
        eip1559_default_estimator, EIP1559_FEE_ESTIMATION_PAST_BLOCKS,
        EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE,
    },
};

use crate::{chain_tx_adapter::EthereumTxPrecursor, SubmitterError};

type FeeEstimator = fn(EthersU256, Vec<Vec<EthersU256>>) -> (EthersU256, EthersU256);

const EVM_RELAYER_ADDRESS: &str = "0x74cae0ecc47b02ed9b9d32e000fd70b9417970c5";

pub type Eip1559Fee = (
    EthersU256, // base fee
    EthersU256, // max fee
    EthersU256, // max priority fee
);

pub async fn estimate_gas_price(
    provider: &Box<dyn EvmProviderForSubmitter>,
    tx_precursor: &mut EthereumTxPrecursor,
    transaction_overrides: &TransactionOverrides,
    domain: &HyperlaneDomain,
) -> Result<(), SubmitterError> {
    let tx = tx_precursor.tx.clone();

    if let Some(gas_price) = transaction_overrides.gas_price {
        // If the gas price is set, we treat as a non-EIP-1559 chain.
        tx_precursor.tx.set_gas_price(gas_price);
        return Ok(());
    }

    let eip1559_fee_result = estimate_eip1559_fees(provider, None, domain, &tx).await;
    let ((base_fee, max_fee, max_priority_fee), _) = match eip1559_fee_result {
        Ok(result) => result,
        Err(err) => {
            warn!(?err, "Failed to estimate EIP-1559 fees");
            // Assume it's not an EIP 1559 chain
            apply_legacy_overrides(tx_precursor, transaction_overrides);
            return Ok(());
        }
    };

    // If the base fee is zero, just treat the chain as a non-EIP-1559 chain.
    // This is useful for BSC, where the base fee is zero, there's a minimum gas price
    // generally enforced by nodes of 3 gwei, but EIP 1559 estimation suggests a priority
    // fee lower than 3 gwei because of privileged transactions being included by block
    // producers that have a lower priority fee.
    if base_fee.is_zero() {
        apply_legacy_overrides(tx_precursor, transaction_overrides);
        return Ok(());
    }

    // Apply overrides for EIP 1559 tx params if they exist.
    let (max_fee, max_priority_fee) =
        apply_1559_overrides(max_fee, max_priority_fee, transaction_overrides);

    // Is EIP 1559 chain
    let mut request = Eip1559TransactionRequest::new();
    if let Some(from) = tx.from() {
        request = request.from(*from);
    }
    if let Some(to) = tx.to() {
        request = request.to(to.clone());
    }
    if let Some(data) = tx.data() {
        request = request.data(data.clone());
    }
    if let Some(value) = tx.value() {
        request = request.value(*value);
    }
    request = request.max_fee_per_gas(max_fee);
    request = request.max_priority_fee_per_gas(max_priority_fee);

    let eip_1559_tx = TypedTransaction::Eip1559(request);
    tx_precursor.tx = eip_1559_tx.clone();
    Ok(())
}

fn apply_legacy_overrides(
    tx_precursor: &mut EthereumTxPrecursor,
    transaction_overrides: &TransactionOverrides,
) {
    let gas_price = tx_precursor.tx.gas_price();
    // if no gas price was set in the tx, leave the tx as is and return early
    let Some(mut gas_price) = gas_price else {
        return;
    };

    let min_price_override = transaction_overrides
        .min_gas_price
        .map(Into::into)
        .unwrap_or(0.into());
    gas_price = gas_price.max(min_price_override);
    gas_price = apply_gas_price_cap(gas_price, transaction_overrides);
    tx_precursor.tx.set_gas_price(gas_price);
}

fn apply_1559_overrides(
    max_fee: EthersU256,
    max_priority_fee: EthersU256,
    transaction_overrides: &TransactionOverrides,
) -> (EthersU256, EthersU256) {
    let mut max_fee = transaction_overrides
        .max_fee_per_gas
        .map(Into::into)
        .unwrap_or(max_fee);
    if let Some(min_fee) = transaction_overrides.min_fee_per_gas {
        max_fee = max_fee.max(min_fee.into());
    }

    let mut max_priority_fee = transaction_overrides
        .max_priority_fee_per_gas
        .map(Into::into)
        .unwrap_or(max_priority_fee);

    if let Some(min_priority_fee) = transaction_overrides.min_priority_fee_per_gas {
        max_priority_fee = max_priority_fee.max(min_priority_fee.into());
    }
    max_fee = apply_gas_price_cap(max_fee, transaction_overrides);
    (max_fee, max_priority_fee)
}

fn apply_gas_price_cap(
    gas_price: EthersU256,
    transaction_overrides: &TransactionOverrides,
) -> EthersU256 {
    if let Some(gas_price_cap) = transaction_overrides.gas_price_cap {
        if gas_price > gas_price_cap.into() {
            warn!(
                ?gas_price,
                ?gas_price_cap,
                "Gas price for transaction is higher than the gas price cap. Capping it to the gas price cap."
            );
            return gas_price_cap.into();
        }
    }
    gas_price
}

/// Use this to estimate EIP 1559 fees with some chain-specific logic.
pub(crate) async fn estimate_eip1559_fees(
    provider: &Box<dyn EvmProviderForSubmitter>,
    estimator: Option<FeeEstimator>,
    domain: &HyperlaneDomain,
    tx: &TypedTransaction,
) -> ChainResult<(Eip1559Fee, Block<TxHash>)> {
    if domain.is_zksync_stack() {
        estimate_eip1559_fees_zksync(provider, tx).await
    } else {
        estimate_eip1559_fees_default(provider, estimator).await
    }
}

async fn estimate_eip1559_fees_zksync(
    provider: &Box<dyn EvmProviderForSubmitter>,
    tx: &TypedTransaction,
) -> ChainResult<(Eip1559Fee, Block<TxHash>)> {
    let latest_block = latest_block(provider).await?;

    let base_fee_per_gas = latest_block
        .base_fee_per_gas
        .ok_or_else(|| ProviderError::CustomError("EIP-1559 not activated".into()))?;

    let response = zksync_estimate_fee(provider, tx).await?;
    let max_fee_per_gas = response.max_fee_per_gas;
    let max_priority_fee_per_gas = response.max_priority_fee_per_gas;

    Ok((
        (base_fee_per_gas, max_fee_per_gas, max_priority_fee_per_gas),
        latest_block,
    ))
}

async fn zksync_estimate_fee(
    provider: &Box<dyn EvmProviderForSubmitter>,
    tx: &TypedTransaction,
) -> ChainResult<ZksyncEstimateFeeResponse> {
    let mut tx = tx.clone();
    tx.set_from(
        // use the sender in the provider if one is set, otherwise default to the EVM relayer address
        provider
            .get_signer()
            .unwrap_or(H160::from_str(EVM_RELAYER_ADDRESS).unwrap()),
    );

    let result = provider.zk_estimate_fee(&tx).await?;
    Ok(result)
}

/// Logic for a vanilla EVM chain to get EIP-1559 fees.
/// Pretty much a copy of the logic in ethers-rs (https://github.com/hyperlane-xyz/ethers-rs/blob/c9ced035628da59376c369be035facda1648577a/ethers-providers/src/provider.rs#L478)
/// but returns the base fee as well as the max fee and max priority fee.
/// Gets a heuristic recommendation of max fee per gas and max priority fee per gas for
/// EIP-1559 compatible transactions.
async fn estimate_eip1559_fees_default(
    provider: &Box<dyn EvmProviderForSubmitter>,
    estimator: Option<FeeEstimator>,
) -> ChainResult<((EthersU256, EthersU256, EthersU256), Block<TxHash>)> {
    let latest_block = latest_block(provider);

    let fee_history = provider.fee_history(
        EIP1559_FEE_ESTIMATION_PAST_BLOCKS.into(),
        BlockNumber::Latest,
        &[EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE],
    );

    let (latest_block, fee_history) = try_join!(latest_block, fee_history)?;

    let base_fee_per_gas = latest_block
        .base_fee_per_gas
        .ok_or_else(|| ProviderError::CustomError("EIP-1559 not activated".into()))?;

    // use the provided fee estimator function, or fallback to the default implementation.
    let (max_fee_per_gas, max_priority_fee_per_gas) = if let Some(es) = estimator {
        es(base_fee_per_gas, fee_history.reward)
    } else {
        eip1559_default_estimator(base_fee_per_gas, fee_history.reward)
    };

    Ok((
        (base_fee_per_gas, max_fee_per_gas, max_priority_fee_per_gas),
        latest_block,
    ))
}

async fn latest_block(provider: &Box<dyn EvmProviderForSubmitter>) -> ChainResult<Block<TxHash>> {
    let latest_block = provider
        .get_block(BlockNumber::Latest)
        .await
        .map_err(ChainCommunicationError::from_other)?
        .ok_or_else(|| ProviderError::CustomError("Latest block not found".into()))?;
    Ok(latest_block)
}
