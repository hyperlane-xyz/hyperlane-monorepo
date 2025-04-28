use std::sync::Arc;

use ethers::{abi::Detokenize, providers::Middleware};
use ethers_contract::{builders::ContractCall, Multicall, MulticallResult, MulticallVersion};
use itertools::{Either, Itertools};
use tokio::sync::Mutex;
use tracing::warn;

use hyperlane_core::{
    utils::hex_or_base58_to_h256, ChainResult, HyperlaneDomain, HyperlaneProvider, U256,
};

use crate::{ConnectionConf, EthereumProvider};

use super::EthereumMailboxCache;

const MULTICALL_GAS_LIMIT_MULTIPLIER_DENOMINATOR: u64 = 80;
const MULTICALL_GAS_LIMIT_MULTIPLIER_NUMERATOR: u64 = 100;
const ALLOW_BATCH_FAILURES: bool = true;

/// Conservative estimate picked by subtracting the gas used by individual calls from the total cost of `aggregate3`
/// based on:
/// - https://dashboard.tenderly.co/shared/simulation/63e85ac7-3ea9-475c-8218-a7c1dd508366/gas-usage
/// - https://dashboard.tenderly.co/tx/arbitrum/0xad644e431dc53c3fc0a074a749d118ff5517346c3f28d8e2513610cc9ab5c91a/gas-usage
const MULTICALL_OVERHEAD_PER_CALL: u64 = 3500;

pub async fn build_multicall<M: Middleware + 'static>(
    provider: Arc<M>,
    conn: &ConnectionConf,
    domain: HyperlaneDomain,
    cache: Arc<Mutex<EthereumMailboxCache>>,
) -> eyre::Result<Multicall<M>> {
    let address = conn
        .op_submission_config
        .batch_contract_address
        .unwrap_or(hex_or_base58_to_h256("0xcA11bde05977b3631167028862bE2a173976CA11").unwrap());
    let is_contract_cache = {
        let cache = cache.lock().await;
        cache.is_contract.get(&address).cloned()
    };
    let is_contract = match is_contract_cache {
        Some(is_contract) => is_contract,
        None => {
            let ethereum_provider = EthereumProvider::new(provider.clone(), domain);
            let is_contract = ethereum_provider.is_contract(&address).await?;
            cache.lock().await.is_contract.insert(address, is_contract);
            is_contract
        }
    };

    if !is_contract {
        return Err(eyre::eyre!("Multicall contract not found at address"));
    }
    let multicall = match Multicall::new(provider.clone(), Some(address.into())).await {
        Ok(multicall) => multicall.version(MulticallVersion::Multicall3),
        Err(err) => {
            return Err(eyre::eyre!(
                "Unable to build multicall contract: {}",
                err.to_string()
            ))
        }
    };

    Ok(multicall)
}

pub fn batch<M, D>(
    multicall: &mut Multicall<M>,
    calls: Vec<ContractCall<M, D>>,
) -> ContractCall<M, Vec<MulticallResult>>
where
    M: Middleware,
    D: Detokenize,
{
    // clear any calls that were in the multicall beforehand
    multicall.clear_calls();

    calls.into_iter().for_each(|call| {
        multicall.add_call(call, ALLOW_BATCH_FAILURES);
    });

    multicall.as_aggregate_3_value()
}

pub fn filter_failed<M, D>(
    calls: Vec<ContractCall<M, D>>,
    results: Vec<MulticallResult>,
) -> (Vec<ContractCall<M, D>>, Vec<usize>) {
    calls
        .into_iter()
        .zip(results)
        .enumerate()
        .partition_map(|(index, (call, result))| {
            if result.success {
                Either::Left(call)
            } else {
                Either::Right(index)
            }
        })
}

pub async fn estimate<M, D>(
    batch: ContractCall<M, D>,
    calls: Vec<ContractCall<M, ()>>,
) -> ChainResult<ContractCall<M, D>>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    let mut individual_estimates_sum = Some(U256::zero());
    let overhead_per_call: U256 = MULTICALL_OVERHEAD_PER_CALL.into();

    calls.into_iter().for_each(|call| {
        individual_estimates_sum = match call.tx.gas() {
            Some(gas_estimate) => {
                let gas_estimate: U256 = gas_estimate.into();
                individual_estimates_sum.map(|sum| sum + gas_estimate + overhead_per_call)
            }
            None => {
                warn!(call=?call.tx, "Unknown gas limit for batched call, falling back to estimating gas for entire batch");
                None
            }
        };
    });

    let mut gas_limit: U256 = batch.estimate_gas().await?.into();
    // Use the max of the sum of individual estimates and the estimate for the entire batch
    if let Some(gas_sum) = individual_estimates_sum {
        gas_limit = gas_limit.max(gas_sum)
    }

    // in practice, even when the full batch lands, no more than 65% of the gas limit is used.
    // this sets the limit lower, but still allows for some overhead, to make it more likely
    // that the tx gets included (due to the lower gas limit)
    let scaled_down_gas_limit = gas_limit * MULTICALL_GAS_LIMIT_MULTIPLIER_DENOMINATOR
        / MULTICALL_GAS_LIMIT_MULTIPLIER_NUMERATOR;

    Ok(batch.gas(scaled_down_gas_limit))
}
