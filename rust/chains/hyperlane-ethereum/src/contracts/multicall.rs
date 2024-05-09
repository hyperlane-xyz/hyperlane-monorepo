use std::sync::Arc;

use ethers::{abi::Detokenize, providers::Middleware};
use ethers_contract::{builders::ContractCall, Multicall, MulticallResult, MulticallVersion};
use hyperlane_core::{utils::hex_or_base58_to_h256, HyperlaneDomain, HyperlaneProvider};

use crate::{ConnectionConf, EthereumProvider};

const ALLOW_BATCH_FAILURES: bool = true;

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

pub fn batch<M: Middleware, D: Detokenize>(
    multicall: &mut Multicall<M>,
    calls: Vec<ContractCall<M, D>>,
) -> ContractCall<M, Vec<MulticallResult>> {
    // clear any calls that were in the multicall beforehand
    multicall.clear_calls();

    calls.into_iter().for_each(|call| {
        multicall.add_call(call, ALLOW_BATCH_FAILURES);
    });

    multicall.as_aggregate_3_value()
}
