use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::Duration;

use ethers::{
    abi::Detokenize,
    prelude::{NameOrAddress, TransactionReceipt},
    providers::ProviderError,
    types::Eip1559TransactionRequest,
};
use ethers_contract::builders::ContractCall;
use ethers_core::{
    types::{BlockNumber, U256 as EthersU256},
    utils::{
        eip1559_default_estimator, EIP1559_FEE_ESTIMATION_PAST_BLOCKS,
        EIP1559_FEE_ESTIMATION_REWARD_PERCENTILE,
    },
};
use hyperlane_core::{utils::bytes_to_hex, ChainCommunicationError, ChainResult, H256, U256};
use tracing::{error, info};

use crate::{Middleware, TransactionOverrides};

/// An amount of gas to add to the estimated gas
const GAS_ESTIMATE_BUFFER: u32 = 50000;

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

    let tx_hash: H256 = (*dispatched).into();

    info!(?to, %data, ?tx_hash, "Dispatched tx");

    match tokio::time::timeout(Duration::from_secs(150), dispatched).await {
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
) -> ChainResult<ContractCall<M, D>>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    let gas_limit = if let Some(gas_limit) = transaction_overrides.gas_limit {
        gas_limit
    } else {
        tx.estimate_gas()
            .await?
            .saturating_add(U256::from(GAS_ESTIMATE_BUFFER).into())
            .into()
    };

    if let Some(gas_price) = transaction_overrides.gas_price {
        // If the gas price is set, we treat as a non-EIP-1559 chain.
        return Ok(tx.gas_price(gas_price).gas(gas_limit));
    }

    let Ok((base_fee, max_fee, max_priority_fee)) = estimate_eip1559_fees(provider, None).await
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
) -> ChainResult<(EthersU256, EthersU256, EthersU256)>
where
    M: Middleware + 'static,
{
    let base_fee_per_gas = provider
        .get_block(BlockNumber::Latest)
        .await
        .map_err(ChainCommunicationError::from_other)?
        .ok_or_else(|| ProviderError::CustomError("Latest block not found".into()))?
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

pub(crate) async fn call_with_lag<M, T>(
    call: ethers::contract::builders::ContractCall<M, T>,
    provider: &M,
    maybe_lag: Option<NonZeroU64>,
) -> ChainResult<ethers::contract::builders::ContractCall<M, T>>
where
    M: Middleware + 'static,
    T: Detokenize,
{
    if let Some(lag) = maybe_lag {
        let fixed_block_number: BlockNumber = provider
            .get_block_number()
            .await
            .map_err(ChainCommunicationError::from_other)?
            .saturating_sub(lag.get().into())
            .into();
        Ok(call.block(fixed_block_number))
    } else {
        Ok(call)
    }
}
