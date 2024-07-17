use std::sync::Arc;

use ethers::{abi::Detokenize, providers::Middleware};
use ethers_contract::{builders::ContractCall, Multicall, MulticallResult, MulticallVersion};
use hyperlane_core::{utils::hex_or_base58_to_h256, HyperlaneDomain, HyperlaneProvider, U256};
use tracing::warn;

use crate::{tx::apply_gas_estimate_buffer, ConnectionConf, EthereumProvider};

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
) -> eyre::Result<Multicall<M>> {
    let address = conn
        .operation_batch
        .batch_contract_address
        .unwrap_or(hex_or_base58_to_h256("0xcA11bde05977b3631167028862bE2a173976CA11").unwrap());
    let ethereum_provider = EthereumProvider::new(provider.clone(), domain);
    if !ethereum_provider.is_contract(&address).await? {
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

pub async fn batch<M, D>(
    multicall: &mut Multicall<M>,
    calls: Vec<ContractCall<M, D>>,
) -> ContractCall<M, Vec<MulticallResult>>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    // clear any calls that were in the multicall beforehand
    multicall.clear_calls();

    let mut individual_estimates_sum = Some(U256::zero());
    let overhead_per_call: U256 = MULTICALL_OVERHEAD_PER_CALL.into();

    // sum over the `call.tx.gas() + overhead_per_call` for each call
    calls.into_iter().for_each(|call| {
        individual_estimates_sum = match call.tx.gas() {
            Some(gas_estimate) => {
                let gas_estimate: U256 = gas_estimate.into();
                individual_estimates_sum.map(|sum| sum + gas_estimate + overhead_per_call)
            }
            None => {
                warn!(call=?call.tx, "Failed to estimate gas for call in batch");
                // if we fail to estimate the gas, we can't accurately estimate the total gas
                // Return a None instead of an error, because this is a non-critical failure
                None
            }
        };
        multicall.add_call(call, ALLOW_BATCH_FAILURES);
    });

    let mut batch_call = multicall.as_aggregate_3_value();
    if let Some(gas_sum) = individual_estimates_sum {
        // Add a buffer to this estimate, to match how gas is estimated for individual txs in `tx.rs::fill_tx_gas_params`
        batch_call = batch_call.gas(apply_gas_estimate_buffer(gas_sum));
    }
    batch_call
}
