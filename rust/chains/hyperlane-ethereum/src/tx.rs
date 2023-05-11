use std::sync::Arc;
use std::time::Duration;

use ethers::abi::Detokenize;
use ethers::prelude::{NameOrAddress, TransactionReceipt};
use ethers::types::Eip1559TransactionRequest;
use ethers_contract::builders::ContractCall;
use tracing::{error, info};

use hyperlane_core::utils::fmt_bytes;
use hyperlane_core::{ChainCommunicationError, ChainResult, KnownHyperlaneDomain, H256, U256};

use crate::Middleware;

/// An amount of gas to add to the estimated gas
const GAS_ESTIMATE_BUFFER: u32 = 50000;

/// Dispatches a transaction, logs the tx id, and returns the result
pub(crate) async fn report_tx<M, D>(tx: ContractCall<M, D>) -> ChainResult<TransactionReceipt>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    let data = tx
        .tx
        .data()
        .map(|b| fmt_bytes(b))
        .unwrap_or_else(|| "None".into());

    let to = tx
        .tx
        .to()
        .cloned()
        .unwrap_or_else(|| NameOrAddress::Address(Default::default()));

    info!(?to, %data, "Dispatching transaction");
    // We can set the gas higher here!
    let dispatch_fut = tx.send();
    let dispatched = dispatch_fut.await?;

    let tx_hash: H256 = *dispatched;

    info!(?to, %data, ?tx_hash, "Dispatched tx");

    match tokio::time::timeout(Duration::from_secs(300), dispatched).await {
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
    tx_gas_limit: Option<U256>,
    provider: Arc<M>,
    domain: u32,
) -> ChainResult<ContractCall<M, D>>
where
    M: Middleware + 'static,
    D: Detokenize,
{
    let gas_limit = if let Some(gas_limit) = tx_gas_limit {
        gas_limit
    } else {
        tx.estimate_gas()
            .await?
            .saturating_add(U256::from(GAS_ESTIMATE_BUFFER))
    };
    let Ok((max_fee, max_priority_fee)) = provider.estimate_eip1559_fees(None).await else {
        // Is not EIP 1559 chain
        return Ok(tx.gas(gas_limit))
    };
    let max_priority_fee = if matches!(
        KnownHyperlaneDomain::try_from(domain),
        Ok(KnownHyperlaneDomain::Polygon)
    ) {
        // Polygon needs a max priority fee >= 30 gwei
        let min_polygon_fee = U256::from(30_000_000_000u64);
        max_priority_fee.max(min_polygon_fee)
    } else {
        max_priority_fee
    };
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
