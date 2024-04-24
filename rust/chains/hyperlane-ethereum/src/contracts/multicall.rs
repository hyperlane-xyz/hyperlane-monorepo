use std::sync::Arc;

use ethers::{
    abi::{Detokenize, Tokenizable},
    providers::{Middleware, PendingTransaction},
};
use ethers_contract::{builders::ContractCall, Multicall, MulticallResult, MulticallVersion};
use hyperlane_core::{ChainResult, TxOutcome};
use tracing::warn;

use crate::{
    error::HyperlaneEthereumError,
    tx::{report_tx, track_pending_tx},
    ConnectionConf,
};

const ALLOW_BATCH_FAILURES: bool = true;

pub async fn build_multicall<M: Middleware>(
    provider: Arc<M>,
    conn: &ConnectionConf,
) -> Option<Multicall<M>> {
    let Some(address) = conn.message_batch.multicall3_address else {
        return None;
    };
    let multicall = match Multicall::new(provider.clone(), Some(address.into())).await {
        Ok(multicall) => multicall.version(MulticallVersion::Multicall3),
        Err(err) => {
            warn!("Unable to build multicall contract: {}", err);
            return None;
        }
    };

    Some(multicall)
}

pub async fn batch<M: Middleware, D: Detokenize>(
    provider: Arc<M>,
    multicall: &mut Multicall<M>,
    calls: Vec<ContractCall<M, D>>,
) -> ChainResult<ContractCall<M, Vec<MulticallResult>>> {
    // clear any calls that were in the multicall beforehand
    multicall.clear_calls();

    calls.into_iter().for_each(|call| {
        multicall.add_call(call, ALLOW_BATCH_FAILURES);
    });

    let res = multicall.as_aggregate_3_value();
    Ok(res)
}
