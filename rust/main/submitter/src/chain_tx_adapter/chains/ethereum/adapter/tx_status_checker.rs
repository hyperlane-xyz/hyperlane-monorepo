// the evm provider-building logic returns a box. `EvmProviderForSubmitter` is only implemented for the underlying type rather than the boxed type.
// implementing the trait for the boxed type would require a lot of boilerplate code.
#![allow(clippy::borrowed_box)]

use ethers::types::U64;
use hyperlane_ethereum::{EthereumReorgPeriod, EvmProviderForSubmitter};
use tracing::warn;

use crate::{SubmitterError, TransactionStatus};

async fn block_number_result_to_tx_hash(
    provider: &Box<dyn EvmProviderForSubmitter>,
    block_number: Option<U64>,
    reorg_period: &EthereumReorgPeriod,
) -> TransactionStatus {
    let Some(block_number) = block_number else {
        return TransactionStatus::PendingInclusion;
    };
    let block_number = block_number.as_u64();
    match provider.get_finalized_block_number(reorg_period).await {
        Ok(finalized_block) => {
            if finalized_block as u64 >= block_number {
                TransactionStatus::Finalized
            } else {
                TransactionStatus::Included
            }
        }
        Err(err) => {
            warn!(
                ?err,
                "Error checking block finality. Assuming tx is pending inclusion"
            );
            TransactionStatus::PendingInclusion
        }
    }
}

pub async fn get_tx_hash_status(
    provider: &Box<dyn EvmProviderForSubmitter>,
    hash: hyperlane_core::H512,
    reorg_period: &EthereumReorgPeriod,
) -> Result<TransactionStatus, SubmitterError> {
    match provider.get_transaction_receipt(hash.into()).await {
        Ok(None) => Err(SubmitterError::TxHashNotFound(
            "Transaction not found".to_string(),
        )),
        Ok(Some(receipt)) => {
            Ok(block_number_result_to_tx_hash(provider, receipt.block_number, reorg_period).await)
        }
        Err(err) => Err(SubmitterError::TxHashNotFound(err.to_string())),
    }
}
