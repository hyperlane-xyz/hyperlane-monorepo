use std::sync::Arc;
use std::time::Duration;

use ethers::{
    abi::Detokenize,
    prelude::{NameOrAddress, TransactionReceipt},
    providers::{JsonRpcClient, PendingTransaction, ProviderError},
    types::{Block, Eip1559TransactionRequest, TxHash},
};
use ethers_contract::builders::ContractCall;
use ethers_core::{
    types::{BlockNumber, U256 as EthersU256},
    utils::{
        eip1559_default_estimator, EIP1559_FEE_ESTIMATION_PAST_BLOCKS,
        EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE,
    },
};
use hyperlane_core::{
    utils::bytes_to_hex, ChainCommunicationError, ChainResult, HyperlaneDomain, ReorgPeriod, H256,
    U256,
};
use tracing::{debug, error, info, warn};

use crate::{EthereumReorgPeriod, Middleware, TransactionOverrides};

/// An amount of gas to add to the estimated gas
pub const GAS_ESTIMATE_BUFFER: u32 = 75_000;

// A multiplier to apply to the estimated gas, i.e. 10%.
pub const GAS_ESTIMATE_MULTIPLIER_NUMERATOR: u32 = 11;
pub const GAS_ESTIMATE_MULTIPLIER_DENOMINATOR: u32 = 10;

pub fn apply_gas_estimate_buffer(gas: U256, domain: &HyperlaneDomain) -> ChainResult<U256> {
    // Arbitrum Nitro chains use 2d fees are are especially prone to costs increasing
    // by the time the transaction lands on chain, requiring a higher gas limit.
    // In this case, we apply a multiplier to the gas estimate.
    let gas = if domain.is_arbitrum_nitro() {
        gas.saturating_mul(GAS_ESTIMATE_MULTIPLIER_NUMERATOR.into())
            .checked_div(GAS_ESTIMATE_MULTIPLIER_DENOMINATOR.into())
            .ok_or_else(|| {
                ChainCommunicationError::from_other_str("Gas estimate buffer divide by zero")
            })?
    } else {
        gas
    };

    // Always add a flat buffer
    Ok(gas.saturating_add(GAS_ESTIMATE_BUFFER.into()))
}

const PENDING_TRANSACTION_POLLING_INTERVAL: Duration = Duration::from_secs(2);

/// Dispatches a transaction, logs the tx id, and returns the result
pub(crate) async fn report_tx<M, D>(tx: ContractCall<M, D>) -> ChainResult<TransactionReceipt>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    let data = tx
        .tx
        .data()
        .map(|b| bytes_to_hex(b))
        .unwrap_or_else(|| "None".into());

    let to = tx
        .tx
        .to()
        .cloned()
        .unwrap_or_else(|| NameOrAddress::Address(Default::default()));

    info!(?to, %data, "Dispatching transaction");
    // We can set the gas higher here!
    let dispatch_fut = tx.send();
    let dispatched = dispatch_fut
        .await?
        .interval(PENDING_TRANSACTION_POLLING_INTERVAL);
    track_pending_tx(dispatched).await
}

pub(crate) async fn track_pending_tx<P: JsonRpcClient>(
    pending_tx: PendingTransaction<'_, P>,
) -> ChainResult<TransactionReceipt> {
    let tx_hash: H256 = (*pending_tx).into();

    info!(?tx_hash, "Dispatched tx");

    match tokio::time::timeout(Duration::from_secs(150), pending_tx).await {
        // all good
        Ok(Ok(Some(receipt))) => {
            info!(?tx_hash, "confirmed transaction");

            Ok(receipt)
        }
        // ethers-rs will return None if it can no longer poll for the tx in the mempool
        Ok(Ok(None)) => Err(ChainCommunicationError::TransactionDropped(tx_hash)),
        // Received error, pass it through
        Ok(Err(x)) => {
            error!(?tx_hash, error = ?x, "encountered error when waiting for receipt");
            Err(x.into())
        }
        // Timed out
        Err(x) => {
            error!(?tx_hash, error = ?x, "waiting for receipt timed out");
            Err(ChainCommunicationError::TransactionTimeout())
        }
    }
}

/// Populates the gas limit and price for a transaction
pub(crate) async fn fill_tx_gas_params<M, D>(
    tx: ContractCall<M, D>,
    provider: Arc<M>,
    transaction_overrides: &TransactionOverrides,
    domain: &HyperlaneDomain,
) -> ChainResult<ContractCall<M, D>>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    // either use the pre-estimated gas limit or estimate it
    let mut estimated_gas_limit: U256 = match tx.tx.gas() {
        Some(&estimate) => estimate.into(),
        None => tx.estimate_gas().await?.into(),
    };

    estimated_gas_limit = apply_gas_estimate_buffer(estimated_gas_limit, domain)?;
    let gas_limit: U256 = if let Some(gas_limit) = transaction_overrides.gas_limit {
        estimated_gas_limit.max(gas_limit)
    } else {
        estimated_gas_limit
    };

    // Cap the gas limit to the block gas limit
    let latest_block = provider
        .get_block(BlockNumber::Latest)
        .await
        .map_err(ChainCommunicationError::from_other)?
        .ok_or_else(|| ProviderError::CustomError("Latest block not found".into()))?;
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

    if let Some(gas_price) = transaction_overrides.gas_price {
        // If the gas price is set, we treat as a non-EIP-1559 chain.
        return Ok(tx.gas_price(gas_price).gas(gas_limit));
    }

    let Ok((base_fee, max_fee, max_priority_fee)) =
        estimate_eip1559_fees(provider, None, &latest_block).await
    else {
        // Is not EIP 1559 chain
        return Ok(tx.gas(gas_limit));
    };

    // If the base fee is zero, just treat the chain as a non-EIP-1559 chain.
    // This is useful for BSC, where the base fee is zero, there's a minimum gas price
    // generally enforced by nodes of 3 gwei, but EIP 1559 estimation suggests a priority
    // fee lower than 3 gwei because of privileged transactions being included by block
    // producers that have a lower priority fee.
    if base_fee.is_zero() {
        return Ok(tx.gas(gas_limit));
    }

    // Apply overrides for EIP 1559 tx params if they exist.
    let max_fee = transaction_overrides
        .max_fee_per_gas
        .map(Into::into)
        .unwrap_or(max_fee);
    let max_priority_fee = transaction_overrides
        .max_priority_fee_per_gas
        .map(Into::into)
        .unwrap_or(max_priority_fee);

    // Is EIP 1559 chain
    let mut request = Eip1559TransactionRequest::new();
    if let Some(from) = tx.tx.from() {
        request = request.from(*from);
    }
    if let Some(to) = tx.tx.to() {
        request = request.to(to.clone());
    }
    if let Some(data) = tx.tx.data() {
        request = request.data(data.clone());
    }
    if let Some(value) = tx.tx.value() {
        request = request.value(*value);
    }
    request = request.max_fee_per_gas(max_fee);
    request = request.max_priority_fee_per_gas(max_priority_fee);
    let mut eip_1559_tx = tx;
    eip_1559_tx.tx = ethers::types::transaction::eip2718::TypedTransaction::Eip1559(request);
    Ok(eip_1559_tx.gas(gas_limit))
}

type FeeEstimator = fn(EthersU256, Vec<Vec<EthersU256>>) -> (EthersU256, EthersU256);

/// Pretty much a copy of the logic in ethers-rs (https://github.com/hyperlane-xyz/ethers-rs/blob/c9ced035628da59376c369be035facda1648577a/ethers-providers/src/provider.rs#L478)
/// but returns the base fee as well as the max fee and max priority fee.
/// Gets a heuristic recommendation of max fee per gas and max priority fee per gas for
/// EIP-1559 compatible transactions.
async fn estimate_eip1559_fees<M>(
    provider: Arc<M>,
    estimator: Option<FeeEstimator>,
    latest_block: &Block<TxHash>,
) -> ChainResult<(EthersU256, EthersU256, EthersU256)>
where
    M: Middleware + 'static,
{
    let base_fee_per_gas = latest_block
        .base_fee_per_gas
        .ok_or_else(|| ProviderError::CustomError("EIP-1559 not activated".into()))?;

    let fee_history = provider
        .fee_history(
            EIP1559_FEE_ESTIMATION_PAST_BLOCKS,
            BlockNumber::Latest,
            &[EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE],
        )
        .await
        .map_err(ChainCommunicationError::from_other)?;

    // use the provided fee estimator function, or fallback to the default implementation.
    let (max_fee_per_gas, max_priority_fee_per_gas) = if let Some(es) = estimator {
        es(base_fee_per_gas, fee_history.reward)
    } else {
        eip1559_default_estimator(base_fee_per_gas, fee_history.reward)
    };

    Ok((base_fee_per_gas, max_fee_per_gas, max_priority_fee_per_gas))
}

pub(crate) async fn call_with_reorg_period<M, T>(
    call: ethers::contract::builders::ContractCall<M, T>,
    provider: &M,
    reorg_period: &ReorgPeriod,
) -> ChainResult<ethers::contract::builders::ContractCall<M, T>>
where
    M: Middleware + 'static,
    T: Detokenize,
{
    if !reorg_period.is_none() {
        let block_id = EthereumReorgPeriod::try_from(reorg_period)?
            .into_block_id(provider)
            .await?;
        Ok(call.block(block_id))
    } else {
        Ok(call)
    }
}
